/**
 * Version restore orchestration (§4 feature #4, design §5.6) — the DB-bound
 * half of the union-safe forward restore. The pure mechanics (schema gate,
 * in-place reconcile) live in src/collab/versionRestore.ts; this service wraps
 * them in the single FOR UPDATE transaction that makes the restore safe.
 *
 * N1 TOCTOU guard: the route's requireDocRole(admin) is only the first check.
 * Here we re-read the doc rows FOR UPDATE and re-check the caller's role +
 * permission_epoch INSIDE the lock, so a writer/reader who bypasses the
 * admin-only frontend and calls POST /restore directly is denied server-side —
 * the backend is the authority, the frontend gate is only UX.
 *
 * Lock order matches persistence.store (yjs_document first, then doc_meta) so
 * the two write paths cannot deadlock. Before the forward write we record an
 * auto safety snapshot of the current live state in the same transaction, so
 * the restore is itself undoable (returned as safetyVersionId).
 */
import { transaction, type Tx } from '../../db/pool.js'
import { yjsDocumentRepo } from '../../db/repos/yjsDocumentRepo.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../../db/repos/docVersionRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { computeFinalState } from '../../collab/persistence.js'
import { gateSchema, restoreReconcile, SchemaIncompatibleError } from '../../collab/versionRestore.js'
import { SCHEMA_VERSION } from '../../schema/index.js'
import { config } from '../../config/env.js'
import { roleAtLeast } from '../../permission/role.js'
import * as Y from 'yjs'

export type RestoreResult =
  | { ok: true; restoredFromVersionId: number; safetyVersionId: number }
  | { ok: false; status: number; error: string }

export interface RestoreInput {
  uid: string
  docId: string
  documentName: string
  versionId: number
  /** permission_epoch observed when the request was authorized (TOCTOU baseline). */
  authorizedEpoch: number
}

interface LockedMetaRow {
  owner_id: string
  permission_epoch: number
  status: number
}

/** Re-check the caller's role under the doc_meta lock (owner => admin). */
async function isAdminTx(tx: Tx, docId: string, uid: string, ownerId: string): Promise<boolean> {
  if (uid === ownerId) return true
  const role = await docMemberRepo.getRoleTx(tx, docId, uid)
  return role !== undefined && roleAtLeast(role, 'admin')
}

export async function restoreVersion(input: RestoreInput): Promise<RestoreResult> {
  // Load the target version (immutable) up front so the schema "newer" gate can
  // fail fast without taking any lock. Cross-doc ids are hidden behind 404.
  const target = await docVersionRepo.getStateById(input.versionId)
  if (!target || target.version.docId !== input.docId) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  const gate = gateSchema(target.version.schemaVersion, SCHEMA_VERSION)
  if (!gate.ok) {
    return { ok: false, status: gate.status, error: gate.code }
  }

  return transaction(async (tx) => {
    // 1. Lock the authoritative state row FIRST (same order as
    //    persistence.store: yjs_document -> doc_meta) and read current state.
    const currentState = await yjsDocumentRepo.selectForUpdateTx(tx, input.documentName)

    // 2. Lock the doc_meta row; re-read role inputs + epoch under the lock.
    const metaRows = await tx.query<LockedMetaRow>(
      'SELECT owner_id, permission_epoch, status FROM doc_meta WHERE doc_id = ? FOR UPDATE',
      [input.docId],
    )
    const meta = metaRows[0]
    if (!meta || Number(meta.status) === 0) return { ok: false, status: 404, error: 'not_found' }
    if (Number(meta.status) === 2) return { ok: false, status: 409, error: 'conflict' }

    // 3. Re-check role INSIDE the lock — server authority, not just frontend UX.
    if (!(await isAdminTx(tx, input.docId, input.uid, meta.owner_id))) {
      return { ok: false, status: 403, error: 'forbidden' }
    }

    // 4. Re-check permission_epoch: if it moved since authorization, abort.
    if (Number(meta.permission_epoch) !== input.authorizedEpoch) {
      return { ok: false, status: 409, error: 'epoch_changed' }
    }

    // 5. Forward, union-safe reconcile of the target into the live state. Do the
    //    fallible work BEFORE recording the safety snapshot: the failure branches
    //    below `return { ok: false }` (an error object, not a throw), and
    //    transaction() only rolls back on a THROW — so an already-inserted safety
    //    row would be COMMITTED, leaking an orphan "Auto-safety before restore"
    //    version on every failed restore. Insert the safety row only once the
    //    restore is known-good (step 6), so a failure rolls back to zero rows.
    let update: Uint8Array
    try {
      update = restoreReconcile(currentState, target.state)
    } catch (err) {
      if (err instanceof SchemaIncompatibleError) {
        return { ok: false, status: 409, error: 'version_schema_incompatible' }
      }
      throw err
    }
    if (update.length > config.maxDocBytes) {
      return { ok: false, status: 413, error: 'doc_too_large' }
    }

    // 6. Auto safety snapshot of the CURRENT live state (undo for the restore),
    //    recorded only after the reconcile + size check have passed.
    const safetyState = currentState ?? Y.encodeStateAsUpdate(new Y.Doc())
    const safetyVersionId = await docVersionRepo.createTx(tx, {
      docId: input.docId,
      documentName: input.documentName,
      kind: KIND_RESTORE_MARKER,
      name: 'Auto-safety before restore',
      state: safetyState,
      schemaVersion: SCHEMA_VERSION,
      createdBy: input.uid,
    })

    // 7. Persist via merge-on-write. The reconcile output is a superset of the
    //    existing state, so this takes the direct-write path (no union reback).
    const { finalState } = computeFinalState(currentState, update)
    await yjsDocumentRepo.upsertStateTx(tx, input.documentName, finalState)
    await tx.query('UPDATE doc_meta SET updated_at = NOW(3), updated_by = ? WHERE document_name = ?', [
      input.uid,
      input.documentName,
    ])

    return { ok: true, restoredFromVersionId: input.versionId, safetyVersionId }
  })
}
