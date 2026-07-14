/**
 * Bot board-scene edit orchestration (mirrors editDocSheet.ts / editDocBody.ts).
 * Three timing phases with a strict lock boundary:
 *
 *   1. Pre-flight (NO lock): read the live board, fail fast on a stale client
 *      base version (412) or an element/file that violates the schema whitelist
 *      (422) or an oversized post-edit doc (413), so most conflicts and all bad
 *      input return before any snapshot row.
 *   2. Auth-recheck + safety-snapshot TRANSACTION: lock yjs_document then doc_meta
 *      FOR UPDATE (same order as persistence.store — deadlock-free), re-check role
 *      + permission_epoch under the lock (server authority — the live write
 *      bypasses onAuthenticate), record a KIND_RESTORE_MARKER safety snapshot of
 *      the PRE-edit state, then COMMIT — releasing both locks before the live
 *      write (commitLiveBoardEdit's disconnect->store re-locks the same
 *      yjs_document row, so holding our lock across it would self-block).
 *   3. LIVE COMMIT (after the tx returns): commitLiveBoardEdit re-asserts the
 *      client base version inside its own transact (the authoritative guard) and
 *      applies the single scene mutation; disconnect flushes durably.
 *
 * The safety snapshot's schema_version is stamped with WB_SCHEMA_VERSION: a board
 * blob is on the whiteboard schema line, isolated from the ProseMirror
 * SCHEMA_VERSION (versionRestore §11.5), so restoring it later gates correctly.
 */
import { transaction, type Tx } from '../../db/pool.js'
import { yjsDocumentRepo } from '../../db/repos/yjsDocumentRepo.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../../db/repos/docVersionRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { readLiveBoard, commitLiveBoardEdit } from '../../collab/liveBoardWrite.js'
import { encodeBaseVersion, stateVectorsEqual, BaseVersionStaleError } from '../../collab/docBodyEdit.js'
import {
  validateBoardOps,
  measureBoardAfterEdit,
  BoardElementInvalidError,
  BoardFileInvalidError,
  type BoardOps,
} from '../../whiteboard/boardEdit.js'
import { WB_SCHEMA_VERSION } from '../../whiteboard/schema/index.js'
import { config } from '../../config/env.js'
import { roleAtLeast, type ResolvedRole } from '../../permission/role.js'
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'

export interface EditBoardSceneInput {
  uid: string
  docId: string
  documentName: string
  /** The client-supplied base version (Y state vector) from If-Match / body. */
  clientBaseVersion: Uint8Array
  /** The raw scene edit batch (elements upsert / deletedElementIds / files). */
  ops: BoardOps
  /** permission_epoch observed when the request was authorized (TOCTOU baseline). */
  authorizedEpoch: number
  /**
   * Whether the caller is a verified bot (#64). Threaded through to the
   * under-lock effective-role recheck so a bot's space membership is taken from
   * its server-verified space, exactly as the route guard does; humans resolve
   * via isSpaceMember. Defaults to false so an omitted flag never over-grants.
   */
  isBot?: boolean
}

export type EditBoardSceneResult =
  | { ok: true; bytes: number; baseVersion: string; newDocVersionSeq: number }
  | {
      ok: false
      status: number
      error: string
      // Storage-dimension observability for the size 413 (added info only).
      docBytes?: number
      limit?: number
    }

interface LockedMetaRow {
  owner_id: string
  permission_epoch: number
  status: number
  // #64: share seam read FRESH under the lock so the under-lock recheck resolves
  // the same effectiveRole as the route guard / live-socket recheck.
  space_id: string
  share_scope: number
  share_role: number
}

/**
 * Re-check the caller has at least writer under the doc_meta lock, applying the
 * SAME effective-role model as the route guard and the live-socket recheck
 * (#64): direct role (owner => admin, else doc_member) merged with the
 * space-share-derived role, so an `anyone_in_space`/edit space member is not
 * 403'd here after passing the route guard.
 */
async function hasWriterTx(tx: Tx, docId: string, uid: string, meta: LockedMetaRow, isBot: boolean): Promise<boolean> {
  const direct: ResolvedRole =
    uid === meta.owner_id ? 'admin' : ((await docMemberRepo.getRoleTx(tx, docId, uid)) ?? 'none')
  const role = await resolveEffectiveRole(uid, direct, {
    space_id: meta.space_id,
    share_scope: Number(meta.share_scope),
    share_role: Number(meta.share_role),
  }, { isBot })
  return roleAtLeast(role, 'writer')
}

/** Map a thrown edit-core / guard error to its HTTP status + code. */
function mapEditError(err: unknown): { status: number; error: string } | null {
  if (err instanceof BaseVersionStaleError) return { status: 412, error: 'base_version_stale' }
  if (err instanceof BoardElementInvalidError) return { status: 422, error: 'board_element_invalid' }
  if (err instanceof BoardFileInvalidError) return { status: 422, error: 'board_file_invalid' }
  return null
}

export async function editBoardScene(input: EditBoardSceneInput): Promise<EditBoardSceneResult> {
  // ── 1. Pre-flight (NO lock) ───────────────────────────────────────────────
  const { state: preEditState, baseSV } = await readLiveBoard(input.documentName)

  // cheap pre-compare: fail most GET<->PATCH conflicts before a snapshot row.
  if (!stateVectorsEqual(input.clientBaseVersion, baseSV)) {
    return { ok: false, status: 412, error: 'base_version_stale' }
  }

  // contract check: surface 422 board_element_invalid / board_file_invalid
  // fail-fast, before any lock or live write, using the SAME validator the live
  // mutation runs.
  let validated
  try {
    validated = validateBoardOps(input.ops)
  } catch (err) {
    const mapped = mapEditError(err)
    if (mapped) return { ok: false, ...mapped }
    throw err
  }

  // size gate: measure the post-edit doc the SAME way persistence.store caps it
  // and reject an overflow HERE — before commitLiveBoardEdit applies the batch to
  // the shared live Y.Doc, broadcasts it, and only then fails at store.
  const { docBytes } = measureBoardAfterEdit(preEditState, validated)
  if (docBytes > config.maxDocBytes) {
    return { ok: false, status: 413, error: 'doc_too_large', docBytes, limit: config.maxDocBytes }
  }

  // ── 2. Auth-recheck + safety-snapshot transaction ─────────────────────────
  const txResult = await transaction(async (tx) => {
    // Lock the authoritative state row FIRST (yjs_document -> doc_meta order).
    await yjsDocumentRepo.selectForUpdateTx(tx, input.documentName)

    const metaRows = await tx.query<LockedMetaRow>(
      'SELECT owner_id, permission_epoch, status, space_id, share_scope, share_role FROM doc_meta WHERE doc_id = ? FOR UPDATE',
      [input.docId],
    )
    const meta = metaRows[0]
    if (!meta || Number(meta.status) === 0) return { ok: false as const, status: 404, error: 'not_found' }
    if (Number(meta.status) === 2) return { ok: false as const, status: 409, error: 'conflict' }

    if (!(await hasWriterTx(tx, input.docId, input.uid, meta, input.isBot ?? false))) {
      return { ok: false as const, status: 403, error: 'forbidden' }
    }
    if (Number(meta.permission_epoch) !== input.authorizedEpoch) {
      return { ok: false as const, status: 409, error: 'epoch_changed' }
    }

    // Safety snapshot of the PRE-edit state: a KIND_RESTORE_MARKER row so the
    // scene edit is itself undoable via the existing restore path. Stamped with
    // WB_SCHEMA_VERSION — the board schema line, not the ProseMirror one.
    const safetyVersionId = await docVersionRepo.createTx(tx, {
      docId: input.docId,
      documentName: input.documentName,
      kind: KIND_RESTORE_MARKER,
      name: 'Auto-safety before board scene edit',
      state: preEditState,
      schemaVersion: WB_SCHEMA_VERSION,
      createdBy: input.uid,
    })

    return { ok: true as const, safetyVersionId }
    // COMMIT here releases both FOR UPDATE locks before the live write.
  })

  if (!txResult.ok) return txResult

  // ── 3. Live commit (after the tx returns) ─────────────────────────────────
  let bytes: number
  let newSV: Uint8Array
  try {
    const committed = await commitLiveBoardEdit(
      input.documentName,
      input.uid,
      input.clientBaseVersion,
      validated,
    )
    bytes = committed.bytes
    newSV = committed.newSV
  } catch (err) {
    // The authoritative in-transact guard backstops any change between the
    // pre-flight and this commit. commitLiveBoardEdit's state-vector guard
    // (BaseVersionStaleError) is its FIRST statement and throws with nothing
    // applied or broadcast, so the safety snapshot is then an orphan restore
    // point for an edit that never touched the board — compensating-delete it.
    // Any OTHER failure is thrown AFTER the batch already applied + broadcast to
    // peers, so the safety snapshot is the ONLY undo record for a change peers
    // have seen: preserve it and surface 500.
    const mapped = mapEditError(err)
    if (mapped) {
      try {
        await docVersionRepo.deleteById(txResult.safetyVersionId)
      } catch {
        /* best-effort rollback; surface the original edit error below */
      }
      return { ok: false, ...mapped }
    }
    throw err
  }

  return {
    ok: true,
    bytes,
    baseVersion: encodeBaseVersion(newSV),
    newDocVersionSeq: txResult.safetyVersionId,
  }
}
