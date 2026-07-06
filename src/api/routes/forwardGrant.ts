/**
 * Forward-grant route (§2 / §9.1, doc_member max-merge).
 *
 *   POST /api/v1/docs/{docId}/forward-grant   { uid, role: "reader"|"writer" }
 *
 * Single-uid granularity: the frontend calls this once per 1v1 recipient and,
 * for a group, loops over the host-expanded member-snapshot uids, aggregating
 * per-uid results into N/M (contract 2 — the backend adds NO batch endpoint).
 *
 * Per-uid status contract:
 *   200 ok              — granted, upgraded, or already >= target (idempotent)
 *   400 bad request     — missing uid / role not reader|writer
 *   403 forbidden       — forwarder is NOT admin/owner (via requireDocRole(admin))
 *   404 user_not_found  — target uid is not a real octo user (anti ghost-member)
 *   404 not_found       — doc missing/deleted ; 409 conflict — archived
 *
 * "Grant only, never downgrade" + epoch bump + owner/admin skip live in the
 * shared grantForwardAccess service. upsertDirect (admin precise set) is NOT
 * touched — this is a physically separate write path.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { roleToNumber } from '../../permission/role.js'
import { grantForwardAccess } from '../services/grantForward.js'

export const forwardGrantRouter = Router()

/** Only reader|writer are grantable via forward (no commenter, admin not forward-grantable). */
function parseGrantRole(v: unknown): 'reader' | 'writer' | null {
  return v === 'reader' || v === 'writer' ? v : null
}

forwardGrantRouter.post('/:docId/forward-grant', async (req: Request, res: Response) => {
  // Authorization to GRANT: only admin/owner may forward-grant (owner => admin).
  // requireDocRole writes 404/409/403 and returns null when blocked.
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
  if (!guard) return

  const { uid, role } = req.body ?? {}
  if (typeof uid !== 'string' || uid === '') {
    res.status(400).json({ error: 'uid required' })
    return
  }
  const parsedRole = parseGrantRole(role)
  if (!parsedRole) {
    res.status(400).json({ error: 'role must be reader|writer' })
    return
  }

  // Anti ghost-member: the target uid must be a real octo user (mirrors PUT members).
  const user = await getOctoIdentity().getUser(uid, req.octoToken)
  if (!user) {
    res.status(404).json({ error: 'user_not_found' })
    return
  }

  const result = await grantForwardAccess({
    docId: guard.meta.doc_id,
    documentName: guard.meta.document_name,
    uid,
    roleNum: roleToNumber(parsedRole),
    grantedBy: req.uid!,
  })

  res.status(200).json({ ok: true, role: result.finalRole, changed: result.changed })
})
