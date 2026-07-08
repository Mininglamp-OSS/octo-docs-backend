/**
 * Member management routes (§8.4, doc_member; needs admin).
 *   GET    /api/v1/docs/{docId}/members
 *   PUT    /api/v1/docs/{docId}/members           (direct add/upsert by uid)
 *   DELETE /api/v1/docs/{docId}/members/{uid}
 */
import { Router, type Request, type Response } from 'express'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { requireDocRole } from '../guard.js'
import { bumpEpoch } from '../../permission/epoch.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { roleToNumber, type Role } from '../../permission/role.js'

export const membersRouter = Router()

const roleName = (n: number): string => (n === 3 ? 'admin' : n === 2 ? 'writer' : 'reader')

function parseRole(v: unknown): Role | null {
  return v === 'reader' || v === 'writer' || v === 'admin' ? v : null
}

/** GET members (needs admin). */
membersRouter.get('/:docId/members', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
  if (!guard) return
  const members = await docMemberRepo.list(req.params.docId!)
  res.status(200).json({
    items: members.map((m) => ({
      uid: m.uid,
      role: roleName(Number(m.role)),
      source: m.source === 2 ? 'invite' : 'direct',
      grantedBy: m.granted_by,
    })),
  })
})

/**
 * PUT members — direct add / change role (upsert by uid; needs admin).
 * MUST first verify the target uid is a real octo user (§8.4 / §4.6 fix):
 * non-existent uid => 404 user_not_found (no ghost member written).
 */
membersRouter.put('/:docId/members', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
  if (!guard) return
  const { uid, role } = req.body ?? {}
  if (typeof uid !== 'string' || uid === '') {
    res.status(400).json({ error: 'uid required' })
    return
  }
  const parsedRole = parseRole(role)
  if (!parsedRole) {
    res.status(400).json({ error: 'role must be reader|writer|admin' })
    return
  }
  // verify target uid exists in octo (anti ghost-member). On the bot mount
  // (req.botToken set by verifyBot) resolve with the bot's own token via the
  // bot user-info route; on the human path resolve with the caller/service
  // token via GET /v1/users/:uid. Either way a miss => 404 user_not_found.
  const user = req.botToken
    ? await getOctoIdentity().getUserAsBot(uid, req.botToken)
    : await getOctoIdentity().getUser(uid, req.octoToken)
  if (!user) {
    res.status(404).json({ error: 'user_not_found' })
    return
  }
  await docMemberRepo.upsertDirect({
    docId: req.params.docId!,
    uid,
    roleNum: roleToNumber(parsedRole),
    grantedBy: req.uid!,
  })
  // doc_member change => epoch +1 + broadcast invalidation (§4.5).
  await bumpEpoch(guard.meta.doc_id, guard.meta.document_name, uid)
  res.status(200).json({ ok: true })
})

/** DELETE member (needs admin); owner cannot be removed (§4.5). */
membersRouter.delete('/:docId/members/:uid', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'admin')
  if (!guard) return
  const targetUid = req.params.uid!
  if (targetUid === guard.meta.owner_id) {
    res.status(403).json({ error: 'owner_cannot_be_removed' })
    return
  }
  await docMemberRepo.remove(req.params.docId!, targetUid)
  await bumpEpoch(guard.meta.doc_id, guard.meta.document_name, targetUid)
  res.status(200).json({ ok: true })
})
