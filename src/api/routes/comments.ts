/**
 * Inline-comment endpoints (feature #3 — doc_comment).
 *   GET    /api/v1/docs/{docId}/comments        (reader)  list thread roots + replies
 *   POST   /api/v1/docs/{docId}/comments        (reader)  create root or reply
 *   PATCH  /api/v1/docs/{docId}/comments/{id}    body edit -> author; status -> writer
 *   DELETE /api/v1/docs/{docId}/comments/{id}    soft -> author; hard -> admin
 *
 * Comments live entirely out-of-band from the Y.Doc. Anchors are opaque encoded
 * Yjs RelativePosition bytes: base64 on the wire, decoded to a Buffer for the
 * BLOB columns and served back as base64. The server never parses them.
 *
 * A root comment's anchors normally come from a browser's live selection. A bot
 * has no live selection, so it may instead supply `anchorText` (+ optional
 * `blockPath` / `occurrence` to disambiguate) and the server resolves it against
 * the live document into the same anchor bytes (feature #70; see anchorResolve).
 * The legacy explicit `anchorStart` / `anchorEnd` path is kept unchanged and
 * always takes precedence, so the existing front-end selection flow is not
 * affected.
 *
 * Product decision: commenting requires the commenter role or higher — a plain
 * read-only reader can view but NOT comment. Viewing comments (list/get) stays
 * at reader. Adjudicating a thread (open/approved/rejected/committed) needs
 * writer; deleting your own comment (soft) needs to be its author; hard delete
 * needs admin. Comment VISIBILITY is never gated by status — a reader sees
 * rejected/committed roots too; approval is only an execution-list FILTER.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { roleAtLeast } from '../../permission/role.js'
import { docCommentRepo, type DocComment } from '../../db/repos/docCommentRepo.js'
import { isStatus, InvalidTransitionError, type Status } from '../../comments/status.js'
import {
  resolveAnchorFromLiveDoc,
  AmbiguousAnchorError,
  AnchorTextNotFoundError,
} from '../../collab/anchorResolve.js'
import type { BlockPath } from '../../collab/docBodyEdit.js'

export const commentsRouter = Router()

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

/**
 * Decoded anchor size cap. A Yjs RelativePosition encodes to a few dozen bytes;
 * 4KB is a very generous ceiling that keeps malformed/oversized payloads out of
 * the anchor BLOB columns.
 */
const MAX_ANCHOR_BYTES = 4096

/** Sentinel: anchor was present on the wire but is not well-formed/usable. */
const INVALID_ANCHOR = Symbol('invalid_anchor')

/**
 * The only doc_type whose live body is a ProseMirror fragment `anchorText` can be
 * resolved against. A sheet/board/whiteboard stores a different Y.Doc shape
 * (COLLAB_FIELD is not a PM fragment), so feeding it to `initProseMirrorDoc`
 * inside the resolver throws. Mirrors docContent.ts's `BODY_EDITABLE_DOC_TYPE`
 * gate — kept local and self-contained so it holds regardless of merge order.
 */
const ANCHOR_RESOLVABLE_DOC_TYPE = 'doc'

/**
 * Reject `anchorText` resolution against a non-rich-text doc_type with a
 * 409 unsupported_doc_type (same contract as docContent.ts). Returns false when
 * blocked so the caller stops before opening/parsing the live document.
 */
function requireAnchorResolvableDocType(res: Response, docType: string): boolean {
  if (docType !== ANCHOR_RESOLVABLE_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

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

/**
 * Decode a base64 anchor string to a Buffer.
 *   - `undefined`        => anchor absent (caller maps to the "required" error)
 *   - `INVALID_ANCHOR`   => anchor present but malformed / empty / oversized
 *   - `Buffer`           => well-formed, within the size cap
 *
 * `Buffer.from(_, 'base64')` is too lax on its own — it silently drops invalid
 * characters (e.g. '@@@@' yields a near-empty buffer). We validate the input is
 * strict, canonical base64 BEFORE decoding, then bound the decoded size.
 */
function decodeAnchor(raw: unknown): Buffer | undefined | typeof INVALID_ANCHOR {
  if (raw === undefined || raw === null) return undefined
  // Present but not a usable string => reject (an anchor must be non-empty).
  if (typeof raw !== 'string' || raw === '') return INVALID_ANCHOR
  // Strict base64: only the alphabet, optional 1-2 '=' padding, length a
  // multiple of 4. This rejects '@@@@', embedded spaces, bad padding, etc.
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return INVALID_ANCHOR
  const buf = Buffer.from(raw, 'base64')
  // Re-encode check catches any remaining lax/non-canonical decodes.
  if (buf.toString('base64') !== raw) return INVALID_ANCHOR
  if (buf.length === 0 || buf.length > MAX_ANCHOR_BYTES) return INVALID_ANCHOR
  return buf
}

/** Sentinel: a supplied disambiguation value is present but not well-formed. */
const INVALID_DISAMBIGUATION = Symbol('invalid_disambiguation')

/**
 * Parse an optional `blockPath` disambiguation value into a child-index path.
 *   - `undefined` / `null`      => absent
 *   - number[] of non-neg ints  => that path
 *   - "0,2,1" comma-separated    => parsed path (CLI passes a string flag)
 *   - anything else             => INVALID_DISAMBIGUATION
 * An empty path is rejected (it addresses the doc root, not a text block).
 */
function parseBlockPath(raw: unknown): BlockPath | undefined | typeof INVALID_DISAMBIGUATION {
  if (raw === undefined || raw === null) return undefined
  let parts: unknown[]
  if (Array.isArray(raw)) {
    parts = raw
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return INVALID_DISAMBIGUATION
    parts = trimmed.split(',').map((s) => s.trim())
  } else {
    return INVALID_DISAMBIGUATION
  }
  if (parts.length === 0) return INVALID_DISAMBIGUATION
  const path: number[] = []
  for (const part of parts) {
    const n =
      typeof part === 'number'
        ? part
        : typeof part === 'string' && /^\d+$/.test(part)
          ? Number(part)
          : NaN
    if (!Number.isInteger(n) || n < 0) return INVALID_DISAMBIGUATION
    path.push(n)
  }
  return path
}

/**
 * Parse an optional 1-based `occurrence` selector.
 *   - `undefined` / `null` => absent
 *   - positive integer     => that occurrence
 *   - anything else        => INVALID_DISAMBIGUATION
 */
function parseOccurrence(raw: unknown): number | undefined | typeof INVALID_DISAMBIGUATION {
  if (raw === undefined || raw === null) return undefined
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(n) || n < 1) return INVALID_DISAMBIGUATION
  return n
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
    status: c.status,
    adjudicatedBy: c.adjudicatedBy,
    adjudicatedAt: c.adjudicatedAt,
    adjudicationNote: c.adjudicationNote,
    // Legacy fields kept for old clients: resolved is derived (status !== 'open').
    resolved: c.resolved,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

commentsRouter.get('/:docId/comments', listCommentsHandler)

export async function listCommentsHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return

  const includeResolved = req.query.includeResolved === '1'
  // Optional lifecycle filter (agent pulls its execution list with ?status=approved).
  // Visibility is NOT gated: any reader may filter to any status, including
  // rejected/committed. When the param is PRESENT but not a valid Status, 400 —
  // silently falling back to the default open list would mask API misuse (esp.
  // the agent execution-list path). An ABSENT param keeps the default behavior.
  const statusRaw = req.query.status
  let status: Status | undefined
  if (statusRaw !== undefined) {
    if (!isStatus(statusRaw)) {
      res.status(400).json({ error: 'invalid status' })
      return
    }
    status = statusRaw
  }
  const cursor = parseId(req.query.cursor)
  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT))

  const roots = await docCommentRepo.listRoots(guard.meta.doc_id, { includeResolved, status, cursor, limit })
  // Batch all replies for this page of roots in ONE query, then group by
  // parent in memory — avoids an N+1 (one listReplies per root, up to ~101).
  const replies = await docCommentRepo.listRepliesForRoots(roots.map((r) => r.id))
  const byParent = new Map<number, DocComment[]>()
  for (const reply of replies) {
    const group = byParent.get(reply.parentId!)
    if (group) group.push(reply)
    else byParent.set(reply.parentId!, [reply])
  }
  const items = roots.map((root) => ({
    ...serialize(root),
    replies: (byParent.get(root.id) ?? []).map(serialize),
  }))
  const nextCursor = roots.length === limit ? roots[roots.length - 1]!.id : null

  res.status(200).json({ items, nextCursor })
}

commentsRouter.post('/:docId/comments', createCommentHandler)

export async function createCommentHandler(req: Request, res: Response): Promise<void> {
  // Product decision (feat/commentable-role): commenting requires commenter or
  // higher; a read-only reader can view comments but cannot create them.
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'commenter', { isBot: req.botToken !== undefined, token: req.octoToken })
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

  // ── Root: anchors are required. Two ways to supply them: ──
  //   (a) legacy — explicit base64 anchorStart/anchorEnd from a live selection;
  //   (b) bot — anchorText (+ optional blockPath/occurrence), resolved here.
  // Legacy explicit anchors always win, so the existing front-end flow (which
  // sends both anchors AND an anchorText snapshot) is untouched.
  const startDec = decodeAnchor(anchorStart)
  const endDec = decodeAnchor(anchorEnd)
  // Present-but-malformed/oversized is rejected distinctly from absent, so a
  // bad anchor is never silently stored as empty.
  if (startDec === INVALID_ANCHOR || endDec === INVALID_ANCHOR) {
    res.status(400).json({ error: 'invalid_anchor' })
    return
  }

  let start: Buffer
  let end: Buffer
  if (startDec && endDec) {
    // (a) Legacy explicit anchors.
    start = startDec
    end = endDec
  } else if (startDec === undefined && endDec === undefined && typeof anchorText === 'string' && anchorText.trim() !== '') {
    // (b) Bot path: resolve anchorText against the live document.
    // Gate the doc_type BEFORE touching the live doc: a non-'doc' target stores a
    // non-ProseMirror Y.Doc, so the resolver's initProseMirrorDoc would throw.
    if (!requireAnchorResolvableDocType(res, guard.meta.doc_type)) return
    const blockPath = parseBlockPath((req.body as Record<string, unknown>).blockPath)
    const occurrence = parseOccurrence((req.body as Record<string, unknown>).occurrence)
    if (blockPath === INVALID_DISAMBIGUATION) {
      res.status(400).json({ error: 'invalid_block_path' })
      return
    }
    if (occurrence === INVALID_DISAMBIGUATION) {
      res.status(400).json({ error: 'invalid_occurrence' })
      return
    }
    try {
      const resolved = await resolveAnchorFromLiveDoc(documentName, { anchorText, blockPath, occurrence })
      start = resolved.anchorStart
      end = resolved.anchorEnd
    } catch (err) {
      // Fail-loud ambiguity/miss contract (design item 3) -> 422.
      if (err instanceof AmbiguousAnchorError) {
        res.status(422).json({ error: 'ambiguous_anchor', matches: err.matches })
        return
      }
      if (err instanceof AnchorTextNotFoundError) {
        res.status(422).json({ error: 'anchor_text_not_found' })
        return
      }
      // Any other failure (bad fragment, live-doc read error, …) is unexpected.
      // This is a bare async Express handler, so a re-thrown rejection would
      // escape as an unhandled rejection — never reaching app.ts's central error
      // middleware — and the client request would hang until timeout. Convert it
      // to a 500 internal_error here, matching docContent.ts's try/catch.
      res.status(500).json({ error: 'internal_error' })
      return
    }
  } else {
    // Neither a full legacy anchor pair nor a usable anchorText.
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
  const guard = await requireDocRole(res, req.uid!, docId, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
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

  const { body, status, resolved, note } = req.body ?? {}

  // Adjudicate a thread root — requires writer (elevated above the reader floor).
  // Accepts either the new `status` field or the legacy `resolved` boolean; both
  // route through the same transition-validated path.
  //   { status: 'open'|'approved'|'rejected'|'committed', note?: string }
  //   { resolved: true }  -> status:'approved'   (legacy compat)
  //   { resolved: false } -> status:'open'       (legacy compat)
  // `committed` may be set by a writer too (the agent acts through a writer/bot
  // identity on the commit-confirm path).
  if (status !== undefined || resolved !== undefined) {
    if (!roleAtLeast(guard.role, 'writer')) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    if (comment.parentId !== null) {
      res.status(400).json({ error: 'only a thread root can be adjudicated' })
      return
    }
    // Resolve the target status from whichever field was supplied.
    let toStatus: Status
    if (status !== undefined) {
      if (!isStatus(status)) {
        res.status(400).json({ error: 'invalid status' })
        return
      }
      toStatus = status
    } else {
      if (typeof resolved !== 'boolean') {
        res.status(400).json({ error: 'resolved must be a boolean' })
        return
      }
      toStatus = resolved ? 'approved' : 'open'
    }
    if (note !== undefined && typeof note !== 'string') {
      res.status(400).json({ error: 'note must be a string' })
      return
    }
    // adjudication_note is VARCHAR(1024); a longer note would truncate silently
    // (or error under STRICT sql_mode) at write time. Reject up front so the
    // limit is explicit rather than mode-dependent.
    if (note !== undefined && note.length > 1024) {
      res.status(400).json({ error: 'note too long (max 1024)' })
      return
    }
    try {
      await docCommentRepo.setStatus(id, toStatus, req.uid!, note ?? '')
    } catch (err) {
      // A disallowed lifecycle move (e.g. committed->open, open->committed) is a
      // client error, not a 500 — surface it as 400 invalid_transition.
      if (err instanceof InvalidTransitionError) {
        res.status(400).json({ error: 'invalid_transition' })
        return
      }
      throw err
    }
    res.status(200).json({ id })
    return
  }

  // Body edit — requires the author (the reader floor above is already enforced).
  if (body !== undefined) {
    if (comment.authorUid !== req.uid) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    // Once a root has been adjudicated (approved/rejected/committed), its text is
    // part of the audit trail (留痕): a reviewer approved *that* text. Letting the
    // author silently rewrite the body afterwards would make the adjudication
    // record lie (adjudicated_by/at still stamp the old decision). Only an `open`
    // comment — not yet decided — may still have its body edited.
    if (comment.status !== 'open') {
      res.status(409).json({ error: 'comment_not_editable' })
      return
    }
    if (typeof body !== 'string' || body.trim() === '') {
      res.status(400).json({ error: 'body required' })
      return
    }
    // The status check above is off a non-locking read, so it closes only the
    // sequential bypass. updateBody does the authoritative compare-and-swap on
    // `status = open AND deleted = 0`; if a reviewer adjudicated (or the row was
    // removed) between the read and the write, it lands 0 rows -> 409, so a
    // concurrent adjudication can't be silently overwritten.
    const edited = await docCommentRepo.updateBody(id, body)
    if (!edited) {
      res.status(409).json({ error: 'comment_not_editable' })
      return
    }
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
  const guard = await requireDocRole(res, req.uid!, docId, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
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
    // doc_id from the guard is authoritative; scopes the destructive cascade.
    await docCommentRepo.hardDelete(id, guard.meta.doc_id)
    res.status(200).json({ id })
    return
  }

  // Soft delete — only the author can remove their own comment.
  if (comment.authorUid !== req.uid) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  // An adjudicated root (approved/rejected/committed) belongs to the audit trail
  // (留痕), not the author: letting an author soft-delete a `committed` row — the
  // proof a change was applied to the live doc — would erase it from every
  // listing (all reads filter deleted = 0) with no writer/admin involvement.
  // Only an `open` (undecided) comment may be author-removed; removing a decided
  // one is a moderator action (hard delete, admin-gated above).
  if (comment.status !== 'open') {
    res.status(409).json({ error: 'comment_not_deletable' })
    return
  }
  // The status check above is a non-locking read (sequential guard only); the
  // authoritative check is softDelete's compare-and-swap on `status = open AND
  // deleted = 0`. If the root was adjudicated (or already removed) between the
  // read and the write, it lands 0 rows -> 409, so a concurrent commit can't be
  // erased out from under the audit trail.
  const removed = await docCommentRepo.softDelete(id)
  if (!removed) {
    res.status(409).json({ error: 'comment_not_deletable' })
    return
  }
  res.status(200).json({ id })
}
