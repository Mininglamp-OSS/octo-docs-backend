/**
 * Bot incremental document-body edit orchestration (design §3.3, mirrors
 * restoreVersion.ts). Three timing phases with a strict lock boundary:
 *
 *   1. Pre-flight (NO lock): read the live doc, fail fast on a stale client
 *      base version / bad anchor / oversized result / bad attachment ref, so most
 *      conflicts return before any snapshot row is written (design item 4 minor).
 *   2. Auth-recheck + safety-snapshot TRANSACTION: lock yjs_document then doc_meta
 *      FOR UPDATE (same order as persistence.store — deadlock-free), re-check role
 *      + permission_epoch under the lock (server authority, not just the route
 *      gate), record a KIND_RESTORE_MARKER safety snapshot of the PRE-edit state,
 *      then COMMIT — releasing both locks before the live write (design item 4b:
 *      commitLiveEdit's disconnect->store re-locks the same yjs_document row, so
 *      holding our lock across it would self-block).
 *   3. LIVE COMMIT (after the tx returns): commitLiveEdit re-asserts the client
 *      base version inside its own transact (the authoritative guard, item 1) and
 *      performs the single reconcile write; disconnect flushes durably.
 */
import { transaction, type Tx } from '../../db/pool.js'
import { yjsDocumentRepo } from '../../db/repos/yjsDocumentRepo.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../../db/repos/docVersionRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { readLiveForEdit, commitLiveEdit } from '../../collab/liveDocWrite.js'
import {
  applyIncrementalOps,
  collectAttachIds,
  sizeAfterEdit,
  stateVectorsEqual,
  encodeBaseVersion,
  schema,
  AnchorNotFoundError,
  AnchorMismatchError,
  InvalidOpsError,
  BaseVersionStaleError,
  SchemaIncompatibleError,
  type DocEditOp,
} from '../../collab/docBodyEdit.js'
import { SCHEMA_VERSION } from '../../schema/index.js'
import { config } from '../../config/env.js'
import { roleAtLeast, type ResolvedRole } from '../../permission/role.js'
import { resolveEffectiveRole } from '../../permission/resolveEffectiveRole.js'

/**
 * An op inserts/replaces an `image` / `fileAttachment` whose `attachId` does not
 * belong to this document (or does not exist) — rejected before any write so a
 * bot cannot embed another doc's or a phantom attachment (locked contract item
 * 8). Mapped to 422 `attachment_not_found`.
 */
export class AttachmentNotFoundError extends Error {
  readonly code = 'attachment_not_found'
  constructor(message = 'attachment_not_found') {
    super(message)
    this.name = 'AttachmentNotFoundError'
  }
}

export interface EditDocBodyInput {
  uid: string
  docId: string
  documentName: string
  /** The client-supplied base version (Y state vector) from If-Match / body. */
  clientBaseVersion: Uint8Array
  ops: DocEditOp[]
  /** permission_epoch observed when the request was authorized (TOCTOU baseline). */
  authorizedEpoch: number
  /**
   * Whether the caller is a verified bot (#64). Threaded through to the
   * under-lock effective-role recheck so a bot's space membership is taken from
   * its server-verified space (cross-space gate), exactly as the route guard
   * does, while a human's is resolved via isSpaceMember. Defaults to false
   * (human) so an omitted flag never over-grants.
   */
  isBot?: boolean
  /**
   * The human caller's octo session token (#64). Threaded to the under-lock
   * effective-role recheck so a human's anyone_in_space membership resolves via
   * verify?include=context, exactly as the route guard does. The bot path
   * short-circuits on isBot and carries no token, so it is omitted there.
   */
  token?: string
}

export type EditDocBodyResult =
  | { ok: true; bytes: number; baseVersion: string; newDocVersionSeq: number }
  | { ok: false; status: number; error: string }

interface LockedMetaRow {
  owner_id: string
  permission_epoch: number
  status: number
  // #64: the share seam the under-lock recheck needs to compute effectiveRole,
  // read FRESH under the FOR UPDATE lock so a scope narrowing is seen at once.
  space_id: string
  share_scope: number
  share_role: number
}

/**
 * Re-check the caller has at least writer under the doc_meta lock, applying the
 * SAME effective-role model as the route guard and the live-socket recheck
 * (#64): direct role (owner => admin, else doc_member) merged with the
 * space-share-derived role. Reading `share_scope`/`share_role` under the lock and
 * running them through `resolveEffectiveRole` keeps all three write-time seams
 * in agreement, so an `anyone_in_space`/edit space member is not 403'd here after
 * passing the route guard.
 */
async function hasWriterTx(tx: Tx, docId: string, uid: string, meta: LockedMetaRow, isBot: boolean, token: string): Promise<boolean> {
  const direct: ResolvedRole =
    uid === meta.owner_id ? 'admin' : ((await docMemberRepo.getRoleTx(tx, docId, uid)) ?? 'none')
  const role = await resolveEffectiveRole(uid, direct, {
    space_id: meta.space_id,
    // Coerce the raw driver TINYINTs so the enum compare in effectiveRole is
    // numeric (mysql2 already returns numbers; defensive, mirroring Number(status)).
    share_scope: Number(meta.share_scope),
    share_role: Number(meta.share_role),
  }, { isBot, token })
  return roleAtLeast(role, 'writer')
}

/** Map a thrown edit-core / guard error to its HTTP status + code. */
function mapEditError(err: unknown): { status: number; error: string } | null {
  if (err instanceof BaseVersionStaleError) return { status: 412, error: 'base_version_stale' }
  if (err instanceof AnchorNotFoundError) return { status: 422, error: 'anchor_not_found' }
  if (err instanceof AnchorMismatchError) return { status: 422, error: 'anchor_mismatch' }
  if (err instanceof InvalidOpsError) return { status: 422, error: 'invalid_ops' }
  if (err instanceof AttachmentNotFoundError) return { status: 422, error: 'attachment_not_found' }
  if (err instanceof SchemaIncompatibleError) return { status: 422, error: 'schema_incompatible' }
  return null
}

export async function editDocBody(input: EditDocBodyInput): Promise<EditDocBodyResult> {
  // ── 1. Pre-flight (NO lock) ───────────────────────────────────────────────
  const { pmDoc, baseSV, preEditState } = await readLiveForEdit(input.documentName)

  // cheap pre-compare: fail most GET<->PATCH conflicts before a snapshot row.
  if (!stateVectorsEqual(input.clientBaseVersion, baseSV)) {
    return { ok: false, status: 412, error: 'base_version_stale' }
  }

  // provisional resolve: surface 422 anchor/schema/invalid-ops fail-fast.
  let newDoc
  try {
    newDoc = applyIncrementalOps(pmDoc, input.ops, schema)
  } catch (err) {
    const mapped = mapEditError(err)
    if (mapped) return { ok: false, ...mapped }
    throw err
  }

  // attachment reference validation (locked contract item 8): every referenced
  // image/fileAttachment attachId must belong to THIS doc.
  const attachIds = collectAttachIds(input.ops)
  for (const attachId of attachIds) {
    const attachment = await docAttachmentRepo.getById(attachId)
    if (!attachment || attachment.docId !== input.docId) {
      return { ok: false, status: 422, error: 'attachment_not_found' }
    }
  }

  // size gate (item 4a): measured live-hydrated, exactly as persistence caps it.
  if (sizeAfterEdit(preEditState, newDoc) > config.maxDocBytes) {
    return { ok: false, status: 413, error: 'doc_too_large' }
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

    if (!(await hasWriterTx(tx, input.docId, input.uid, meta, input.isBot ?? false, input.token ?? ''))) {
      return { ok: false as const, status: 403, error: 'forbidden' }
    }
    if (Number(meta.permission_epoch) !== input.authorizedEpoch) {
      return { ok: false as const, status: 409, error: 'epoch_changed' }
    }

    // Safety snapshot of the PRE-edit state (decision 5): a KIND_RESTORE_MARKER
    // row so the edit is itself undoable via the existing restore path.
    const safetyVersionId = await docVersionRepo.createTx(tx, {
      docId: input.docId,
      documentName: input.documentName,
      kind: KIND_RESTORE_MARKER,
      name: 'Auto-safety before bot edit',
      state: preEditState,
      schemaVersion: SCHEMA_VERSION,
      createdBy: input.uid,
    })

    return { ok: true as const, safetyVersionId }
    // COMMIT here releases both FOR UPDATE locks before the live write (item 4b).
  })

  if (!txResult.ok) return txResult

  // ── 3. Live commit (after the tx returns) ─────────────────────────────────
  let bytes: number
  let newSV: Uint8Array
  try {
    const committed = await commitLiveEdit(
      input.documentName,
      input.uid,
      input.clientBaseVersion,
      input.ops,
      schema,
    )
    bytes = committed.bytes
    newSV = committed.newSV
  } catch (err) {
    // The authoritative in-transact guard backstops any change between the
    // pre-flight and this commit — a drift fails here with no mutation/broadcast.
    // Phase 2 already committed the KIND_RESTORE_MARKER safety snapshot and
    // released its locks, so a rejection here would otherwise leave an orphan
    // restore point for an edit that never touched the body. Compensating-delete
    // it so a rejected (e.g. 412) request leaves no doc_version side effect
    // (locked contract: "does not affect version/restore behaviour"). A failure
    // of the compensating delete must not mask the original edit error.
    try {
      await docVersionRepo.deleteById(txResult.safetyVersionId)
    } catch {
      /* best-effort rollback; surface the original edit error below */
    }
    const mapped = mapEditError(err)
    if (mapped) return { ok: false, ...mapped }
    throw err
  }

  return {
    ok: true,
    bytes,
    baseVersion: encodeBaseVersion(newSV),
    newDocVersionSeq: txResult.safetyVersionId,
  }
}
