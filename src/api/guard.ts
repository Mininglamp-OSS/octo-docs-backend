/**
 * Shared REST permission guards (§4.2 / §8.4).
 */
import type { Response } from 'express'
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { resolveRole } from '../permission/resolveRole.js'
import { roleAtLeast, type ResolvedRole, type Role } from '../permission/role.js'

export interface DocGuard {
  meta: DocMeta
  role: ResolvedRole
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
): Promise<DocGuard | null> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (meta.space_id !== spaceId) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return null
  }
  const role = await resolveRole(uid, docId)
  if (role === 'none' || !roleAtLeast(role, minRole)) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  return { meta, role }
}
