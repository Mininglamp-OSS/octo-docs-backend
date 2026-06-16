/**
 * Inline-comment endpoints (feature #3 — doc_comment).
 *   GET    /api/v1/docs/{docId}/comments        (reader)  list thread roots + replies
 *   POST   /api/v1/docs/{docId}/comments        (reader)  create root or reply
 *   PATCH  /api/v1/docs/{docId}/comments/{id}    body edit -> author; resolve -> writer
 *   DELETE /api/v1/docs/{docId}/comments/{id}    soft -> author; hard -> admin
 *
 * Comments live entirely out-of-band from the Y.Doc. Anchors are opaque encoded
 * Yjs RelativePosition bytes: base64 on the wire, decoded to a Buffer for the
 * BLOB columns and served back as base64. The server never parses them.
 *
 * Product decision: read => can comment, so creating a comment only needs the
 * reader role. Resolving/reopening a thread needs writer; deleting your own
 * comment (soft) needs to be its author; hard delete needs admin.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { roleAtLeast } from '../../permission/role.js'
import { docCommentRepo, type DocComment } from '../../db/repos/docCommentRepo.js'

export const commentsRouter = Router()

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/** Parse a positive integer id from a path/body value, or null when malformed. */
function parseId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

/** Decode a base64 anchor string to a Buffer; returns undefined when absent/invalid. */
function decodeAnchor(raw: unknown): Buffer | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  return Buffer.from(raw, 'base64')
}

/** Serialize a stored comment for the wire (anchors -> base64). */
function serialize(c: DocComment) {
  return {
    id: c.id,
    docId: c.docId,
    parentId: c.parentId,
    authorUid: c.authorUid,
    body: c.body,
    anchorStart: c.anchorStart ? c.anchorStart.toString('base64') : null,
    anchorEnd: c.anchorEnd ? c.anchorEnd.toString('base64') : null,
    anchorText: c.anchorText,
    resolved: c.resolved,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

commentsRouter.get('/:docId/comments', listCommentsHandler)

export async function listCommentsHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  const includeResolved = req.query.includeResolved === '1'
  const cursor = parseId(req.query.cursor)
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT))

  const roots = await docCommentRepo.listRoots(guard.meta.doc_id, { includeResolved, cursor, limit })
  const items = []
  for (const root of roots) {
    const replies = await docCommentRepo.listReplies(root.id)
    items.push({ ...serialize(root), replies: replies.map(serialize) })
  }
  const nextCursor = roots.length === limit ? roots[roots.length - 1]!.id : null

  res.status(200).json({ items, nextCursor })
}

commentsRouter.post('/:docId/comments', createCommentHandler)

export async function createCommentHandler(req: Request, res: Response): Promise<void> {
  // Product decision: read => can comment.
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  const { body, anchorStart, anchorEnd, anchorText, parentId } = req.body ?? {}

  if (typeof body !== 'string' || body.trim() === '') {
    res.status(400).json({ error: 'body required' })
    return
  }

  const docId = guard.meta.doc_id
  const documentName = guard.meta.document_name

  if (parentId !== undefined && parentId !== null) {
    // ── Reply: must point at an existing root in THIS doc; no anchors. ──
    const pid = parseId(parentId)
    if (pid === null) {
      res.status(400).json({ error: 'invalid parentId' })
      return
    }
    const parent = await docCommentRepo.getById(pid)
    // Hide cross-doc references behind 404 (do not leak existence).
    if (!parent || parent.docId !== docId || parent.deleted) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (parent.parentId !== null) {
      // Single-level nesting only: cannot reply to a reply.
      res.status(400).json({ error: 'parent is not a thread root' })
      return
    }
    const id = await docCommentRepo.create({
      docId,
      documentName,
      parentId: pid,
      authorUid: req.uid!,
      body,
      anchorStart: null,
      anchorEnd: null,
      anchorText: '',
    })
    res.status(201).json({ id })
    return
  }

  // ── Root: both anchors are required (opaque base64 -> Buffer). ──
  const start = decodeAnchor(anchorStart)
  const end = decodeAnchor(anchorEnd)
  if (!start || !end) {
    res.status(400).json({ error: 'anchorStart and anchorEnd required for a root comment' })
    return
  }
  const id = await docCommentRepo.create({
    docId,
    documentName,
    parentId: null,
    authorUid: req.uid!,
    body,
    anchorStart: start,
    anchorEnd: end,
    anchorText: typeof anchorText === 'string' ? anchorText.slice(0, 512) : '',
  })
  res.status(201).json({ id })
}

commentsRouter.patch('/:docId/comments/:id', patchCommentHandler)

export async function patchCommentHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Doc-access floor: a reader role is the minimum to touch any comment here.
  // This runs FIRST so it 404s on missing/deleted docs, 409s on archived ones,
  // and 403s a caller whose role is 'none' (e.g. revoked author) — before the
  // author check below ever gets a chance to allow a write.
  const guard = await requireDocRole(res, req.uid!, docId, 'reader')
  if (!guard) return

  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const comment = await docCommentRepo.getById(id)
  // Cross-doc / missing / deleted => 404 (do not leak existence).
  if (!comment || comment.docId !== docId || comment.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const { body, resolved } = req.body ?? {}

  // Resolve / reopen a thread root — requires writer (elevated above the floor).
  if (resolved !== undefined) {
    if (!roleAtLeast(guard.role, 'writer')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (comment.parentId !== null) {
      res.status(400).json({ error: 'only a thread root can be resolved' })
      return
    }
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'resolved must be a boolean' })
      return
    }
    await docCommentRepo.setResolved(id, resolved, req.uid!)
    res.status(200).json({ id })
    return
  }

  // Body edit — requires the author (the reader floor above is already enforced).
  if (body !== undefined) {
    if (comment.authorUid !== req.uid) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (typeof body !== 'string' || body.trim() === '') {
      res.status(400).json({ error: 'body required' })
      return
    }
    await docCommentRepo.updateBody(id, body)
    res.status(200).json({ id })
    return
  }

  res.status(400).json({ error: 'nothing to update' })
}

commentsRouter.delete('/:docId/comments/:id', deleteCommentHandler)

export async function deleteCommentHandler(req: Request, res: Response): Promise<void> {
  const docId = req.params.docId!
  // Doc-access floor (see patchCommentHandler): blocks revoked authors and
  // enforces doc-status 404/409 semantics before the author check below.
  const guard = await requireDocRole(res, req.uid!, docId, 'reader')
  if (!guard) return

  const id = parseId(req.params.id)
  if (id === null) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  const comment = await docCommentRepo.getById(id)
  if (!comment || comment.docId !== docId || comment.deleted) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const hard = req.query.hard === '1'

  if (hard) {
    // Hard delete is a moderator action — needs admin (admin/owner).
    if (!roleAtLeast(guard.role, 'admin')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    await docCommentRepo.hardDelete(id)
    res.status(200).json({ id })
    return
  }

  // Soft delete — only the author can remove their own comment.
  if (comment.authorUid !== req.uid) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  await docCommentRepo.softDelete(id)
  res.status(200).json({ id })
}
