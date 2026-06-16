/**
 * Version history endpoints (§4 feature #4 — snapshot + restore). Mounted under
 * /api/v1/docs.
 *
 *   GET    /:docId/versions                     reader  — list (id-cursor paged)
 *   POST   /:docId/versions                     writer  — named snapshot of live
 *   GET    /:docId/versions/:versionId/state    reader  — raw Yjs bytes (preview)
 *   PATCH  /:docId/versions/:versionId          writer  — rename a snapshot
 *   DELETE /:docId/versions/:versionId          admin   — delete a snapshot
 *   POST   /:docId/versions/:versionId/restore  admin   — restore (server authority)
 *
 * Restore is the hard core: a forward, non-destructive reconcile of the target
 * version into the live authoritative state (see versionRestore.ts), delegated
 * to the restoreVersion service (src/api/services/restoreVersion.ts) which runs
 * it inside ONE write transaction that locks the doc rows (SELECT ... FOR UPDATE)
 * and RE-CHECKS the caller's role + permission_epoch under the lock (§5.6 N1
 * TOCTOU guard). The admin-only gate is enforced server-side — the frontend
 * admin-only is UX; this is the authority. A safety snapshot of the pre-restore
 * state is recorded first so the restore is itself undoable.
 */
import { Router, type Request, type Response } from 'express'
import * as Y from 'yjs'
import { requireDocRole } from '../guard.js'
import { docVersionRepo, KIND_NAMED } from '../../db/repos/docVersionRepo.js'
import { persistence } from '../../collab/persistence.js'
import { restoreVersion } from '../services/restoreVersion.js'
import { SCHEMA_VERSION } from '../../schema/index.js'

export const versionsRouter = Router()

const MAX_NAME_LEN = 256

/** Shape a version row for the list / item JSON response. */
function toItem(v: {
  id: number
  kind: number
  name: string
  sizeBytes: number
  schemaVersion: number
  createdAt: Date
  createdBy: string
}) {
  return {
    id: v.id,
    kind: v.kind,
    name: v.name,
    sizeBytes: v.sizeBytes,
    schemaVersion: v.schemaVersion,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  }
}

/** Parse the :versionId path param to a positive integer, or null if invalid. */
function parseVersionId(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ── GET /:docId/versions — list (reader) ──────────────────────────────────────
versionsRouter.get('/:docId/versions', listVersionsHandler)

export async function listVersionsHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  const cursorRaw = req.query.cursor
  const cursor = typeof cursorRaw === 'string' && cursorRaw !== '' ? Number(cursorRaw) : undefined
  const limitRaw = req.query.limit
  const limit = typeof limitRaw === 'string' && limitRaw !== '' ? Number(limitRaw) : undefined
  const includeAuto = req.query.includeAuto === '1' || req.query.includeAuto === 'true'

  const { items, nextCursor } = await docVersionRepo.listByDoc(guard.meta.doc_id, {
    cursor: Number.isFinite(cursor) ? cursor : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    includeAuto,
  })
  res.status(200).json({ items: items.map(toItem), nextCursor })
}

// ── POST /:docId/versions — named snapshot of the live state (writer) ─────────
versionsRouter.post('/:docId/versions', createVersionHandler)

export async function createVersionHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'writer')
  if (!guard) return

  const { name } = req.body ?? {}
  if (name !== undefined && (typeof name !== 'string' || name.length > MAX_NAME_LEN)) {
    res.status(400).json({ error: 'invalid_name' })
    return
  }

  const documentName = guard.meta.document_name
  // Snapshot the CURRENT live authoritative state. A doc with no edits yet has
  // no yjs_document row; snapshot an empty Y.Doc so the column stays NOT NULL.
  const live = await persistence.fetch(documentName)
  const state = live ?? Y.encodeStateAsUpdate(new Y.Doc())

  const id = await docVersionRepo.create({
    docId: guard.meta.doc_id,
    documentName,
    kind: KIND_NAMED,
    name: typeof name === 'string' ? name : '',
    state,
    schemaVersion: SCHEMA_VERSION,
    createdBy: req.uid!,
  })
  res.status(201).json({ id })
}

// ── GET /:docId/versions/:versionId/state — raw Yjs bytes (reader) ────────────
versionsRouter.get('/:docId/versions/:versionId/state', getVersionStateHandler)

export async function getVersionStateHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  const versionId = parseVersionId(req.params.versionId)
  if (versionId === null) {
    res.status(400).json({ error: 'invalid_version_id' })
    return
  }

  const found = await docVersionRepo.getStateById(versionId)
  // Hide cross-doc references behind 404 (do not leak existence to other docs).
  if (!found || found.version.docId !== guard.meta.doc_id) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  // Raw uncompressed Yjs state for a client-side throwaway Y.Doc preview.
  res.status(200)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.send(Buffer.from(found.state))
}

// ── PATCH /:docId/versions/:versionId — rename (writer) ───────────────────────
versionsRouter.patch('/:docId/versions/:versionId', renameVersionHandler)

export async function renameVersionHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'writer')
  if (!guard) return

  const versionId = parseVersionId(req.params.versionId)
  if (versionId === null) {
    res.status(400).json({ error: 'invalid_version_id' })
    return
  }
  const { name } = req.body ?? {}
  if (typeof name !== 'string' || name === '' || name.length > MAX_NAME_LEN) {
    res.status(400).json({ error: 'invalid_name' })
    return
  }

  const existing = await docVersionRepo.getById(versionId)
  if (!existing || existing.docId !== guard.meta.doc_id) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await docVersionRepo.rename(versionId, name)
  res.status(200).json({ id: versionId })
}

// ── DELETE /:docId/versions/:versionId — delete (admin) ───────────────────────
versionsRouter.delete('/:docId/versions/:versionId', deleteVersionHandler)

export async function deleteVersionHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'admin')
  if (!guard) return

  const versionId = parseVersionId(req.params.versionId)
  if (versionId === null) {
    res.status(400).json({ error: 'invalid_version_id' })
    return
  }
  const existing = await docVersionRepo.getById(versionId)
  if (!existing || existing.docId !== guard.meta.doc_id) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await docVersionRepo.deleteById(versionId)
  res.status(200).json({ id: versionId })
}

// ── POST /:docId/versions/:versionId/restore — restore (admin) ────────────────
versionsRouter.post('/:docId/versions/:versionId/restore', restoreVersionHandler)

export async function restoreVersionHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Initial authorization (admin-only). The authoritative recheck happens again
  // under the row lock inside the service — this is the cheap pre-check / 404 pass.
  const guard = await requireDocRole(res, req.uid!, docId, 'admin')
  if (!guard) return

  const versionId = parseVersionId(req.params.versionId)
  if (versionId === null) {
    res.status(400).json({ error: 'invalid_version_id' })
    return
  }

  // The service performs the union-safe forward reconcile inside ONE FOR UPDATE
  // transaction and RE-CHECKS role + permission_epoch under the lock (§5.6 N1
  // TOCTOU guard) — the server is the authority, the frontend admin-only is UX.
  const result = await restoreVersion({
    uid: req.uid!,
    docId,
    documentName: guard.meta.document_name,
    versionId,
    authorizedEpoch: guard.meta.permission_epoch,
  })
  if (result.ok) {
    res.status(200).json({
      restoredFromVersionId: result.restoredFromVersionId,
      safetyVersionId: result.safetyVersionId,
    })
    return
  }
  res.status(result.status).json({ error: result.error })
}
