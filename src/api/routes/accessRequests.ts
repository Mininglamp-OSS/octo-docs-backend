/**
 * Access-request routes (§4.3, screen 4c — "request access" MVP, pull-based).
 *
 *   POST /api/v1/docs/{docId}/access-requests                    submit (any octo login)
 *   GET  /api/v1/docs/{docId}/access-requests?status=pending     list  (needs admin)
 *   POST /api/v1/docs/{docId}/access-requests/{requestId}/approve approve (needs admin)
 *   POST /api/v1/docs/{docId}/access-requests/{requestId}/deny    deny    (needs admin)
 *
 * Approval reuses the SAME max-merge grant path as forward-grant
 * (grantForwardAccess: only-up, epoch bump, owner/admin skip). Denial leaves the
 * requester forbidden.
 *
 * NOTE (§4.2 / scope item 6): notification to owner+admin is PULL-based this
 * round — requests land in the table and admins fetch the pending list. Active
 * push to owner+admin is a second-phase backlog item (docs-backend has no
 * outbound IM capability today; octoIdentity only verifies tokens / looks up
 * users), intentionally NOT built here.
 */
import { Router, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import {
  docAccessRequestRepo,
  REQUEST_STATUS_PENDING,
  REQUEST_STATUS_APPROVED,
  REQUEST_STATUS_DENIED,
} from '../../db/repos/docAccessRequestRepo.js'
import { requireDocRole, requireSameSpace } from '../guard.js'
import { resolveRole } from '../../permission/resolveRole.js'
import { grantForwardAccess } from '../services/grantForward.js'
import { roleAtLeast, roleToNumber, type Role } from '../../permission/role.js'

export const accessRequestsRouter = Router()

const roleName = (n: number): string => (n === 2 ? 'writer' : 'reader')

/** Only reader|writer can be requested / approved (no commenter/admin). */
function parseReqRole(v: unknown, fallback: 'reader' | 'writer' = 'reader'): 'reader' | 'writer' {
  return v === 'reader' || v === 'writer' ? v : fallback
}

/**
 * POST submit — any authenticated octo user (no doc role required). Idempotent
 * by (doc_id, uid). If the caller already holds >= the requested role, returns
 * 200 already_granted without writing a row.
 */
accessRequestsRouter.post('/:docId/access-requests', async (req: Request, res: Response) => {
  const docId = req.params.docId!
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta || meta.status === 0) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // Space-scope gate (P2): a doc in another space must be indistinguishable
  // from a missing one, so a cross-space hit returns 404 BEFORE any status
  // branch. This submit route is the only one in the router that skips
  // requireDocRole (submit needs no doc role), so without this check a caller
  // whose server-resolved space is A could probe or write an access-request row
  // against a doc in space B — a cross-space existence/state oracle plus a
  // cross-space write. Reusing the shared guard helper keeps this identical to
  // the role-guarded routes and hardens both the human and bot mounts at once.
  if (!requireSameSpace(res, meta, req.spaceId!)) {
    return
  }
  if (meta.status === 2) {
    res.status(409).json({ error: 'conflict' })
    return
  }

  const requestedRole: Role = parseReqRole((req.body ?? {}).requestedRole)
  const reasonRaw = (req.body ?? {}).reason
  const reason = typeof reasonRaw === 'string' ? reasonRaw.slice(0, 512) : ''

  // Already sufficiently privileged => no-op idempotent success (no request row).
  const current = await resolveRole(req.uid!, docId)
  if (roleAtLeast(current, requestedRole)) {
    res.status(200).json({ status: 'already_granted', role: current })
    return
  }

  const out = await docAccessRequestRepo.submit({
    docId,
    uid: req.uid!,
    requestedRoleNum: roleToNumber(requestedRole),
    reason,
  })
  res.status(201).json({ requestId: out.requestId, status: 'pending' })
})

/** GET list requests by status (needs admin; default pending). */
accessRequestsRouter.get('/:docId/access-requests', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
  if (!guard) return
  const statusParam = req.query.status
  const statusNum =
    statusParam === 'approved'
      ? REQUEST_STATUS_APPROVED
      : statusParam === 'denied'
        ? REQUEST_STATUS_DENIED
        : REQUEST_STATUS_PENDING
  const items = await docAccessRequestRepo.listByStatus(req.params.docId!, statusNum)
  res.status(200).json({
    items: items.map((r) => ({
      requestId: r.request_id,
      uid: r.uid,
      requestedRole: roleName(Number(r.requested_role)),
      reason: r.reason,
      createdAt: r.created_at,
    })),
  })
})

/**
 * POST approve (needs admin). Consumes the pending request FIRST, then grants
 * the chosen role via the shared max-merge path (only-up + epoch bump +
 * owner/admin skip).
 *
 * The decide() -> grant order is load-bearing: decide() carries the only
 * `WHERE status = pending` guard and reports whether it actually transitioned a
 * row. Granting only when decide() returns true means a replayed, double-
 * submitted, or already-decided request (denied OR approved) can never授权 —
 * a denial is never silently overwritten and an approval is never double-
 * granted. A non-pending request is a 409 (already decided) with no grant.
 */
accessRequestsRouter.post(
  '/:docId/access-requests/:requestId/approve',
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
    if (!guard) return
    const request = await docAccessRequestRepo.getByRequestId(req.params.docId!, req.params.requestId!)
    if (!request) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Approver picks the level; default to what was requested.
    const grantRole = parseReqRole((req.body ?? {}).role, roleName(Number(request.requested_role)) as 'reader' | 'writer')

    // Transition pending -> approved first; grant only on a genuine transition.
    const decided = await docAccessRequestRepo.decide({
      docId: req.params.docId!,
      requestId: req.params.requestId!,
      status: REQUEST_STATUS_APPROVED,
      decidedBy: req.uid!,
    })
    if (!decided) {
      // Already denied / approved / cancelled (or lost a concurrent race):
      // the request is no longer pending, so we grant nothing.
      res.status(409).json({ error: 'not_pending' })
      return
    }

    const result = await grantForwardAccess({
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      uid: request.uid,
      roleNum: roleToNumber(grantRole),
      grantedBy: req.uid!,
    })
    res.status(200).json({ ok: true, role: result.finalRole })
  },
)

/** POST deny (needs admin). Marks the request denied; requester stays forbidden. */
accessRequestsRouter.post(
  '/:docId/access-requests/:requestId/deny',
  async (req: Request, res: Response) => {
    const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
    if (!guard) return
    const request = await docAccessRequestRepo.getByRequestId(req.params.docId!, req.params.requestId!)
    if (!request) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    await docAccessRequestRepo.decide({
      docId: req.params.docId!,
      requestId: req.params.requestId!,
      status: REQUEST_STATUS_DENIED,
      decidedBy: req.uid!,
    })
    res.status(200).json({ ok: true })
  },
)
