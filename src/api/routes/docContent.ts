/**
 * Bot document-body content endpoints (design §2). Incremental edit + live read
 * of a document's ProseMirror body, mounted on BOTH the human /api/v1/docs chain
 * and the bot /v1/bot/docs chain (see app.ts) so each reads req.uid / req.spaceId
 * from whichever identity middleware ran.
 *
 *   PATCH /:docId/content   writer  — incremental edit under a strict If-Match
 *                                     client base-version guard (§2.1)
 *   GET   /:docId/content   reader  — read the LIVE body + its base version (§2.2)
 *
 * The route gate (requireDocRole) is UX / a cheap 404 pass; the authoritative
 * role + permission_epoch recheck happens again under the row lock inside the
 * editDocBody service, because the live write path bypasses onAuthenticate.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveForEdit } from '../../collab/liveDocWrite.js'
import { editDocBody } from '../services/editDocBody.js'
import { encodeBaseVersion, parseBaseVersion, type DocEditOp } from '../../collab/docBodyEdit.js'
import { SCHEMA_VERSION } from '../../schema/index.js'

export const docContentRouter = Router()

/** Extract the base-version token from the If-Match header or the body mirror. */
function readBaseVersion(req: Request): string | null {
  const header = req.headers['if-match']
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw === 'string' && raw.trim() !== '') {
    // If-Match carries the token as a quoted entity-tag; strip the quotes.
    return raw.trim().replace(/^"(.*)"$/, '$1')
  }
  const bodyBase = (req.body ?? {}).baseVersion
  if (typeof bodyBase === 'string' && bodyBase !== '') return bodyBase
  return null
}

/** Every entry of `path` must be a non-negative integer. */
function isValidPath(path: unknown): path is number[] {
  return Array.isArray(path) && path.length > 0 && path.every((n) => Number.isInteger(n) && (n as number) >= 0)
}

/**
 * A root-container insert: the empty path `[]` addresses the doc root and is
 * legal ONLY for `insert` with `inside_start` / `inside_end` (insert as the
 * doc's first / last child — the sole way to write the first block into an
 * empty document). `before` / `after` and replace/delete against the root stay
 * rejected via isValidPath, which still requires a non-empty path.
 */
function isRootInsertPosition(path: unknown, position: unknown): boolean {
  return (
    Array.isArray(path) &&
    path.length === 0 &&
    (position === 'inside_start' || position === 'inside_end')
  )
}

/** Structural (shape-only) validation of the op batch — a bad shape is a 400. */
function validateOpsShape(ops: unknown): ops is DocEditOp[] {
  if (!Array.isArray(ops) || ops.length === 0) return false
  return ops.every((op) => {
    if (!op || typeof op !== 'object') return false
    const o = op as Record<string, unknown>
    if (o.type === 'insert') {
      const at = o.at as { path?: unknown; position?: unknown } | undefined
      const positions = ['before', 'after', 'inside_start', 'inside_end']
      return (
        !!at &&
        typeof at.position === 'string' &&
        positions.includes(at.position) &&
        (isValidPath(at.path) || isRootInsertPosition(at.path, at.position)) &&
        Array.isArray(o.content)
      )
    }
    if (o.type === 'replace' || o.type === 'delete') {
      const range = o.range as { from?: { path?: unknown }; to?: { path?: unknown } } | undefined
      if (!range || !range.from || !range.to || !isValidPath(range.from.path) || !isValidPath(range.to.path)) {
        return false
      }
      return o.type === 'delete' ? true : Array.isArray(o.content)
    }
    return false
  })
}

// ── GET /:docId/content — read the live body (reader) ─────────────────────────
docContentRouter.get('/:docId/content', getDocContentHandler)

export async function getDocContentHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader')
  if (!guard) return

  try {
    const { pmDoc, baseSV } = await readLiveForEdit(guard.meta.document_name)
    res.status(200).json({
      docId: guard.meta.doc_id,
      doc: pmDoc.toJSON(),
      schemaVersion: SCHEMA_VERSION,
      baseVersion: encodeBaseVersion(baseSV),
    })
  } catch {
    res.status(500).json({ error: 'internal_error' })
  }
}

// ── PATCH /:docId/content — incremental edit (writer) ─────────────────────────
docContentRouter.patch('/:docId/content', patchDocContentHandler)

export async function patchDocContentHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer')
  if (!guard) return

  const baseVersionRaw = readBaseVersion(req)
  if (baseVersionRaw === null) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const ops = (req.body ?? {}).ops
  if (!validateOpsShape(ops)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }

  try {
    const result = await editDocBody({
      uid: req.uid!,
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      clientBaseVersion: parseBaseVersion(baseVersionRaw),
      ops,
      authorizedEpoch: guard.meta.permission_epoch,
    })
    if (result.ok) {
      res.status(200).json({
        docId: guard.meta.doc_id,
        bytes: result.bytes,
        baseVersion: result.baseVersion,
        newDocVersionSeq: result.newDocVersionSeq,
      })
      return
    }
    res.status(result.status).json({ error: result.error })
  } catch {
    res.status(500).json({ error: 'internal_error' })
  }
}
