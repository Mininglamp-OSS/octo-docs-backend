/**
 * Shared REST permission guards (§4.2 / §8.4).
 */
import type { Response } from 'express'
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { resolveRole } from '../permission/resolveRole.js'
import { roleAtLeast, type ResolvedRole, type Role } from '../permission/role.js'
import { resolveEffectiveRole } from '../permission/resolveEffectiveRole.js'

export interface DocGuard {
  meta: DocMeta
  role: ResolvedRole
}

/**
 * Caller-principal hints the #64 share path needs. A verified BOT carries a
 * server-resolved space on `req.spaceId` (verifyBot reverse-lookup, anti-spoof),
 * so once the cross-space 404 gate has confirmed `req.spaceId === meta.space_id`
 * the bot is by definition an active member of the doc's space — no octo-server
 * membership call, no dependency on the new endpoint. HUMANS carry an unverified
 * `X-Space-Id`, so their membership is resolved lazily via isSpaceMember. The
 * router handlers are shared between the human and bot mounts, so this is passed
 * per-request as `{ isBot: req.botToken !== undefined }`. Restricted docs never
 * consult it (share path is a no-op), so omitting it is safe there.
 */
export interface DocRoleCaller {
  isBot?: boolean
}

/**
 * Cross-space 404 gate (P2). A doc that lives in another space must be
 * indistinguishable from one that does not exist, so an out-of-space hit
 * returns 404 not_found (never 403) — matching the not_found semantics for
 * cross-doc references and never leaking a doc's existence outside the caller's
 * space. Writes the 404 and returns false when the doc is out of space.
 *
 * Shared by requireDocRole and the role-less access-request submit handler so
 * both mounts (human /api/v1/docs and bot /v1/bot/docs) enforce identical space
 * scoping from a single definition rather than a forked bespoke check.
 */
export function requireSameSpace(res: Response, meta: DocMeta, spaceId: string): boolean {
  if (meta.space_id !== spaceId) {
    res.status(404).json({ error: 'not_found' })
    return false
  }
  return true
}

/**
 * Load the doc and resolve the caller's role, enforcing a minimum role.
 * Writes the appropriate HTTP error and returns null when blocked:
 *   404 doc missing/deleted, 404 cross-space, 409 archived, 403 insufficient role.
 *
 * The `spaceId` gate (P2) is checked before the role/403 check so a doc that
 * lives in another space is never distinguishable from one that does not exist:
 * a cross-space hit returns 404 (not 403), matching the existing not_found
 * semantics for cross-doc references (versions/comments/attachments) and never
 * leaking the existence of a doc outside the caller's space.
 */
export async function requireDocRole(
  res: Response,
  uid: string,
  docId: string,
  spaceId: string,
  minRole: Role,
  caller: DocRoleCaller = {},
): Promise<DocGuard | null> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (!requireSameSpace(res, meta, spaceId)) {
    return null
  }
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return null
  }
  const direct = await resolveRole(uid, docId)
  // #64 space-scoped share (design §5.1): effectiveRole = max(directRole,
  // share-derived). Resolved through the shared seam so the returned role is the
  // caller's TRUE effective role — not merely "enough to pass minRole". A direct
  // reader of an anyone_in_space/edit doc must be reported as `writer` here (the
  // read/load responses echo guard.role to the client), so the resolution is NOT
  // gated on minRole; resolveEffectiveRole still short-circuits (zero IO) for
  // restricted docs and callers already at writer/admin.
  const role = await resolveEffectiveRole(uid, direct, meta, caller)
  if (role === 'none' || !roleAtLeast(role, minRole)) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { meta, role }
}
