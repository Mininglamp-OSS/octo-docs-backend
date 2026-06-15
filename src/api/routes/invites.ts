/**
 * Link invite routes (§8.4 / §4.6, doc_invite).
 *   POST   /api/v1/docs/{docId}/invites                (needs admin)
 *   GET    /api/v1/docs/{docId}/invites                (needs admin)
 *   DELETE /api/v1/docs/{docId}/invites/{inviteToken}  (needs admin)
 *   POST   /api/v1/docs/invites/{inviteToken}/accept   (octo login; §4.6 flow)
 */
import { Router, type Request, type Response } from 'express'
import { docInviteRepo } from '../../db/repos/docInviteRepo.js'
import { requireDocRole } from '../guard.js'
import { newInviteToken } from '../../util/ids.js'
import { roleToNumber, type Role } from '../../permission/role.js'
import { acceptInvite } from '../services/acceptInvite.js'
import { extractOctoToken } from '../middleware/auth.js'
import { config } from '../../config/env.js'

export const invitesRouter = Router()

const roleName = (n: number): string => (n === 3 ? 'admin' : n === 2 ? 'writer' : 'reader')

function parseRole(v: unknown): Role {
  return v === 'reader' || v === 'admin' ? v : 'writer' // default writer (§4.6)
}

/** POST create invite (needs admin). */
invitesRouter.post('/:docId/invites', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'admin')
  if (!guard) return
  const { role, expiresAt, maxUses } = req.body ?? {}
  const roleVal = parseRole(role)
  const maxUsesNum = Number.isInteger(maxUses) && maxUses >= 0 ? Number(maxUses) : 0
  let expires: Date | null = null
  if (typeof expiresAt === 'string' && expiresAt !== '') {
    const d = new Date(expiresAt)
    if (Number.isNaN(d.getTime())) {
      res.status(400).json({ error: 'invalid expiresAt' })
      return
    }
    expires = d
  }
  const inviteToken = newInviteToken()
  await docInviteRepo.create({
    inviteToken,
    docId: req.params.docId!,
    roleNum: roleToNumber(roleVal),
    maxUses: maxUsesNum,
    expiresAt: expires,
    createdBy: req.uid!,
  })
  res.status(201).json({
    inviteToken,
    url: `${publicHost(req)}/docs/invite/${inviteToken}`,
    role: roleVal,
  })
})

/** GET list active invites (needs admin). */
invitesRouter.get('/:docId/invites', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'admin')
  if (!guard) return
  const invites = await docInviteRepo.listActive(req.params.docId!)
  res.status(200).json({
    items: invites.map((i) => ({
      inviteToken: i.invite_token,
      role: roleName(Number(i.role)),
      maxUses: i.max_uses,
      usedCount: i.used_count,
      expiresAt: i.expires_at,
    })),
  })
})

/** DELETE revoke invite (needs admin). */
invitesRouter.delete('/:docId/invites/:inviteToken', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'admin')
  if (!guard) return
  const invite = await docInviteRepo.get(req.params.inviteToken!)
  if (!invite || invite.doc_id !== req.params.docId!) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  await docInviteRepo.revoke(req.params.inviteToken!)
  res.status(200).json({ ok: true })
})

/**
 * POST accept (§4.6). Requires octo login (not the doc admin). Exported as a
 * SEPARATE router so it can be mounted BEFORE authMiddleware (it returns its
 * own 401 login_required; the accept service verifies identity itself).
 */
export const acceptInviteRouter = Router()

acceptInviteRouter.post('/invites/:inviteToken/accept', async (req: Request, res: Response) => {
  const octoToken = extractOctoToken(req)
  const out = await acceptInvite(octoToken, req.params.inviteToken!)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.body)
})

function publicHost(req: Request): string {
  // Best-effort public base URL for the share link. The attachment bucket /
  // host wiring is environment-specific; default to the request's host.
  const proto = req.header('x-forwarded-proto') ?? req.protocol
  const host = req.header('host') ?? `localhost:${config.httpPort}`
  return `${proto}://${host}`
}
