/**
 * Document CRUD routes (§8.4): create / list / rename / soft-delete.
 * Mounted under /api/v1/docs.
 */
import { Router, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../../db/repos/docViewHistoryRepo.js'
import { normalizeTypeFilter } from '../../db/docType.js'
import { buildDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { refreshAndPublish, bumpEpoch } from '../../permission/epoch.js'
import { ROLE_ADMIN } from '../../permission/role.js'
import {
  parseShareScope,
  parseShareRole,
  shareScopeName,
  shareRoleName,
  SHARE_SCOPE_ANYONE,
  SHARE_ROLE_READ,
} from '../../permission/shareScope.js'
import { buildWhiteboardName, WhiteboardNameError } from '../../whiteboard/schema/index.js'
import { newDocId } from '../../util/ids.js'
import { buildDocShareUrl } from '../../util/docShareLink.js'
import { config } from '../../config/env.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { requireDocRole } from '../guard.js'

export const docsRouter = Router()

const DEFAULT_FOLDER = 'f_default'

/** Serialize the numeric doc_member role to the wire string enum (§3 wire). */
const roleName = (n: number): 'admin' | 'writer' | 'reader' =>
  n === 3 ? 'admin' : n === 2 ? 'writer' : 'reader'

/** Normalize a repeated query param (`?creator=a&creator=b`) to a string[]. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') return [v]
  return []
}

/**
 * docType value the front-end stamps on whiteboards (DocsHome create menu /
 * docsApi). Boards persist + address under the 5-segment `:wb:` key; everything
 * else is a rich-text document under the 4-segment key.
 */
const WHITEBOARD_DOC_TYPE = 'board'

/**
 * Build the canonical persistence/routing document_name for a freshly created
 * doc. This is the SINGLE place a new key is minted, and it must agree with the
 * key the client addresses on join and the key onAuthenticate parses:
 *
 *   - whiteboard (docType 'board'): `octo:{space}:{folder}:wb:{docId}` (5-seg) —
 *     the board id is the {board} segment (BoardSession passes `board: docId`),
 *     so collab-token issuance + WS auth resolve the row by the same key the
 *     browser joins with. Minting a 4-seg `d_` key here was the hop-2 join 404:
 *     persistence wrote 4-seg while the client/auth path addressed 5-seg `:wb:`.
 *   - document: `octo:{space}:{folder}:{docId}` (4-seg).
 *
 * Throws DocumentNameError / WhiteboardNameError on an illegal segment.
 */
export function buildCreatedDocumentName(
  spaceId: string,
  folder: string,
  docId: string,
  docType: string,
): string {
  // documentName 3rd segment MUST equal folder_id (§8.1 invariant).
  return docType === WHITEBOARD_DOC_TYPE
    ? buildWhiteboardName(spaceId, folder, docId)
    : buildDocumentName(spaceId, folder, docId)
}

/** POST /api/v1/docs — create. Creator becomes owner (implicit admin, §4.2). */
export async function createDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const { folderId, title, docType } = req.body ?? {}
  // Space isolation (P3): the space is sourced solely from the enforced
  // X-Space-Id header (req.spaceId, set by spaceContextMiddleware, guaranteed
  // non-empty). The transitional body.spaceId fallback (P1) is removed — any
  // spaceId in the request body is ignored; the header is the single source of
  // truth. The empty guard below stays as defense-in-depth for the header.
  const spaceId = req.spaceId ?? ''
  if (spaceId === '') {
    res.status(400).json({ error: 'spaceId required' })
    return
  }
  const folder = typeof folderId === 'string' && folderId !== '' ? folderId : DEFAULT_FOLDER
  const resolvedDocType = typeof docType === 'string' && docType !== '' ? docType : 'doc'
  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildCreatedDocumentName(spaceId, folder, docId, resolvedDocType)
  } catch (err) {
    if (err instanceof DocumentNameError || err instanceof WhiteboardNameError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
  await docMetaRepo.create({
    docId,
    documentName,
    title: typeof title === 'string' ? title : '',
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: resolvedDocType,
    createdBy: uid,
  })
  // Bot path only: the doc owner is the bot itself (ownerId = bot uid), so the
  // bot's human owner would otherwise have no membership and could not see the
  // doc. Auto-grant that human owner admin. req.botOwnerUid is set solely by
  // verifyBot (from octo-server's robot.creator_uid reverse lookup) and only when
  // a real human creator exists — it is never set on the human mount, so this
  // block is a no-op there. Skip when the owner is the bot itself (no distinct
  // human owner, e.g. a platform bot) to avoid a redundant self-membership row.
  // This is purely additive: the doc's owner field and the bot's own access are
  // unchanged (§4.2 owner is implicit admin); the human owner is added on top.
  const botOwnerUid = req.botOwnerUid
  if (botOwnerUid && botOwnerUid !== uid) {
    await docMemberRepo.upsertDirect({
      docId,
      uid: botOwnerUid,
      roleNum: ROLE_ADMIN,
      grantedBy: uid,
    })
    // Mirror the PUT /members mutation: a doc_member change bumps the epoch and
    // broadcasts the invalidation (§4.5) so any listener recomputes access.
    await bumpEpoch(docId, documentName, botOwnerUid)
  }
  const meta = await docMetaRepo.getByDocId(docId)
  res.status(201).json({
    docId,
    documentName,
    title: meta?.title ?? '',
    spaceId,
    folderId: folder,
    ownerId: uid,
    docType: resolvedDocType,
    role: 'admin',
    createdAt: meta?.created_at,
    // Canonical browser-facing link a caller can pass straight to chat. See
    // buildDocShareUrl / config.webOrigin.
    shareUrl: buildDocShareUrl(config.webOrigin, docId, spaceId),
  })
}

docsRouter.post('/', createDocHandler)

/** GET /api/v1/docs/{docId} — fetch one doc's metadata (needs reader). */
export async function getDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
  if (!guard) return
  const { meta, role } = guard
  res.status(200).json({
    docId: meta.doc_id,
    documentName: meta.document_name,
    title: meta.title,
    ownerId: meta.owner_id,
    spaceId: meta.space_id,
    folderId: meta.folder_id,
    docType: meta.doc_type,
    role,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    // Canonical browser-facing link a caller can pass straight to chat. See
    // buildDocShareUrl / config.webOrigin.
    shareUrl: buildDocShareUrl(config.webOrigin, meta.doc_id, meta.space_id),
    // #64: additive share-scope fields so the client dialog can render current
    // state without a second round-trip to GET /:docId/share. Coerced through the
    // fail-safe name mappers, so an unexpected stored value reads as the most
    // restrictive (restricted / read).
    shareScope: shareScopeName(meta.share_scope),
    shareRole: shareRoleName(meta.share_role),
    ...(meta.permission_epoch != null ? { permissionEpoch: meta.permission_epoch } : {}),
  })
}

/** GET /api/v1/docs — list docs the caller owns or is a member of. */
docsRouter.get('/', async (req: Request, res: Response) => {
  const uid = req.uid!
  // Space isolation (P1): the space is the enforced X-Space-Id header
  // (req.spaceId, set by spaceContextMiddleware), never a client-supplied query
  // param. Listing is hard-scoped to that space.
  const spaceId = req.spaceId!
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : undefined
  // FEAT-B: `owner=me` narrows to strictly the caller's own docs (excludes
  // shared-with-me); `q` is a filename substring search. Both are optional and
  // additive — omitting them preserves the pre-FEAT-B behavior verbatim.
  const owner = req.query.owner === 'me' ? 'me' : undefined
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  // FEAT-B/XIN-1188: optional multi-value `?type=` kind filter (repeated param,
  // never CSV). Validated against the fixed enum; unknown/absent => no filter.
  const types = normalizeTypeFilter(req.query.type)
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const sort = req.query.sort === 'updatedAt:asc' ? 'updatedAt:asc' : 'updatedAt:desc'

  const { total, items } = await docMetaRepo.listForUser({ uid, spaceId, folderId, owner, q, types, page, pageSize, sort })
  res.status(200).json({
    total,
    items: items.map((d) => ({
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      docType: d.doc_type,
      role: roleName(Number(d.role)),
      updatedAt: d.updated_at,
    })),
  })
})

/**
 * POST /api/v1/docs/{docId}/view — record that the caller opened this doc
 * (FEAT-B ingest, §3.1). Idempotent UPSERT on (uid, doc_id): a re-open only
 * refreshes viewed_at, never adds a row. uid is derived server-side; any uid /
 * viewedBy in the body is ignored. Needs reader (reuses requireDocRole guard).
 */
export async function recordDocViewHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, req.spaceId!, 'reader', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return
  const viewedAt = await docViewHistoryRepo.upsertViewWithPrune({
    uid,
    docId,
    spaceId: req.spaceId!,
    retainCount: config.docView.retainCount,
    retainDays: config.docView.retainDays,
  })
  res.status(200).json({ ok: true, viewedAt: new Date(viewedAt).toISOString() })
}

docsRouter.post('/:docId/view', recordDocViewHandler)

/**
 * GET /api/v1/docs/recent — the caller's recently-viewed docs (FEAT-B, §3.2).
 * keyset-paginated, viewed_at DESC. Query-time filtering (status + permission)
 * lives in the repo, so revoked / deleted / archived docs drop out immediately.
 */
export async function listRecentHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const creators = toStringArray(req.query.creator)
  // FEAT-B/XIN-1188: optional multi-value `?type=` kind filter (same convention
  // as `creator`). Validated against the fixed enum; unknown/absent => no filter.
  const types = normalizeTypeFilter(req.query.type)
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  let result
  try {
    result = await docViewHistoryRepo.listRecent({ uid, spaceId, q, creators, types, cursor, pageSize })
  } catch (err) {
    if (err instanceof Error && err.message === 'invalid_cursor') {
      res.status(400).json({ error: 'invalid_cursor' })
      return
    }
    throw err
  }
  res.status(200).json({
    total: result.total,
    items: result.items.map((d) => ({
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      docType: d.doc_type,
      role: roleName(Number(d.role)),
      updatedAt: d.updated_at,
      viewedAt: new Date(d.viewed_at).toISOString(),
    })),
    nextCursor: result.nextCursor,
  })
}

docsRouter.get('/recent', listRecentHandler)

/**
 * GET /api/v1/docs/recent/creators — distinct creators of the caller's
 * recently-viewed docs for the CreatorFilter dropdown (FEAT-B, §3.4). Scope:
 * q-filtered, creator-NOT-filtered, pre-pagination, permission-filtered — the
 * full distinct owner set. Display names are resolved server-side so the
 * front-end needs no per-uid lookups; a uid that fails to resolve falls back to
 * its own value as the name (a directory hiccup never drops a candidate).
 */
export async function listRecentCreatorsHandler(req: Request, res: Response) {
  const uid = req.uid!
  const spaceId = req.spaceId!
  const q = typeof req.query.q === 'string' ? req.query.q : undefined
  const ownerIds = await docViewHistoryRepo.listCreators({ uid, spaceId, q })
  const nameByUid = new Map<string, string>()
  if (ownerIds.length > 0) {
    const users = await getOctoIdentity().getUsers(ownerIds, req.octoToken)
    for (const u of users) {
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      if (name !== '') nameByUid.set(u.uid, name)
    }
  }
  res.status(200).json({
    creators: ownerIds.map((id) => ({ uid: id, name: nameByUid.get(id) ?? id })),
  })
}

docsRouter.get('/recent/creators', listRecentCreatorsHandler)

// Registered after GET '/' so the collection route is matched distinctly from
// the single-doc route (Express treats '/' and '/:docId' as separate paths).
docsRouter.get('/:docId', getDocHandler)

/** PATCH /api/v1/docs/{docId} — rename (needs admin). */
docsRouter.patch('/:docId', async (req: Request, res: Response) => {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const { title } = req.body ?? {}
  if (typeof title !== 'string' || title === '') {
    res.status(400).json({ error: 'title required' })
    return
  }
  await docMetaRepo.rename(docId, title)
  res.status(200).json({ docId, title })
})

/** DELETE /api/v1/docs/{docId} — soft delete (needs admin). */
docsRouter.delete('/:docId', async (req: Request, res: Response) => {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, req.spaceId!, 'admin', { isBot: req.botToken !== undefined })
  if (!guard) return
  const deleted = await docMetaRepo.softDelete(docId)
  // Broadcast the epoch invalidation so connected writers recheck and get cut
  // off (status===0 -> resolveRole 'none'). Doc-wide (no uid): everyone loses
  // access on delete. Mirrors acceptInvite's refreshAndPublish call.
  if (deleted) {
    await refreshAndPublish(deleted.documentName, deleted.permissionEpoch)
  }
  res.status(200).json({ docId, status: 'deleted' })
})

/**
 * GET /api/v1/docs/{docId}/share — read a doc's share settings (#64, needs
 * reader). Anyone who can see the doc can see its scope, so the client dialog
 * can render current state for any viewer. 404 (not 403) for a missing/deleted
 * or cross-space doc (requireDocRole existence-hiding ordering); 403 when the
 * caller has no effective role on the doc.
 */
export async function getShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', {
    isBot: req.botToken !== undefined,
    token: req.octoToken,
  })
  if (!guard) return
  res.status(200).json({
    docId: guard.meta.doc_id,
    shareScope: shareScopeName(guard.meta.share_scope),
    shareRole: shareRoleName(guard.meta.share_role),
  })
}

/**
 * PUT /api/v1/docs/{docId}/share — change a doc's share settings (#64, needs
 * admin; owner is implicit admin). Mirrors the members mutation shape: guard,
 * validate, write, bump epoch.
 *
 *   body: { shareScope: "restricted"|"anyone_in_space", shareRole?: "read"|"edit" }
 *   400 invalid_scope   shareScope not in enum
 *   400 invalid_role    shareScope=anyone_in_space but shareRole missing/invalid
 *   403 forbidden       caller is not admin/owner (requireDocRole admin gate)
 *   404 not_found       doc missing/deleted OR cross-space
 *   409 conflict        archived (status=2)
 *
 * Normalization (design §3.2): when shareScope=restricted the handler persists
 * share_role=read regardless of any shareRole sent (the field is ignored, not
 * rejected), so the stored row stays canonical and the read API is deterministic.
 * The write is followed by a DOC-WIDE epoch bump (no uid) so a narrowing cuts
 * every non-member's live session, exactly like soft-delete.
 */
export async function putShareHandler(req: Request, res: Response) {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin', {
    isBot: req.botToken !== undefined,
  })
  if (!guard) return
  const { shareScope, shareRole } = req.body ?? {}
  const scopeNum = parseShareScope(shareScope)
  if (scopeNum === null) {
    res.status(400).json({ error: 'invalid_scope' })
    return
  }
  let roleNum: number
  if (scopeNum === SHARE_SCOPE_ANYONE) {
    // anyone_in_space requires an explicit, valid share role.
    const parsed = parseShareRole(shareRole)
    if (parsed === null) {
      res.status(400).json({ error: 'invalid_role' })
      return
    }
    roleNum = parsed
  } else {
    // restricted: normalize+persist read, ignoring any body shareRole.
    roleNum = SHARE_ROLE_READ
  }
  // Flip the share settings AND bump the epoch atomically (one transaction), so
  // a narrowing is never observable at the new scope with a stale epoch. Then
  // refresh caches + publish the doc-wide invalidation (no uid) so every
  // non-member's live session re-derives access (§3.2 / §5.3), mirroring the
  // softDelete -> refreshAndPublish path.
  const newEpoch = await docMetaRepo.setShareSettings(guard.meta.doc_id, scopeNum, roleNum)
  await refreshAndPublish(guard.meta.document_name, newEpoch)
  res.status(200).json({
    docId: guard.meta.doc_id,
    shareScope: shareScopeName(scopeNum),
    shareRole: shareRoleName(roleNum),
  })
}

// Two-segment paths: distinct from the single-segment '/:docId' route, so
// registration order relative to it does not matter (Express keys on segment
// count). Registered here alongside the other single-doc routes.
docsRouter.get('/:docId/share', getShareHandler)
docsRouter.put('/:docId/share', putShareHandler)
