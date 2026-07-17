/**
 * AuthMiddleware (§4.7 / §8.4).
 *
 * Business/metadata REST endpoints are authenticated with the octo session
 * token. In same-origin octo-web, the apiClient injects a `token` header
 * (NOT Authorization: Bearer — §4.7(c)); we also accept Authorization: Bearer
 * as a generic placeholder. The trusted uid is resolved via OctoIdentity
 * (§4.7(a)) — the client never supplies its own uid.
 */
import type { Request, Response, NextFunction } from 'express'
import { getOctoIdentity } from '../../auth/octoIdentity.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string
      octoToken?: string
      // Set on the human path (authMiddleware): the uids of bots this human user
      // owns (octo-server verify `owned_bots`). Used so "my documents"
      // (owner=me) also surfaces docs a user's bots own. Defaults to [] when the
      // identity source omits it (fail-closed: caller sees only their own docs).
      ownedBots?: string[]
      // Set only on the bot mount (verifyBot): the bot's own bearer token, used
      // to authenticate bot-realm octo-server lookups (the anti ghost-member
      // existence check in members/forwardGrant). Never set on the human path.
      botToken?: string
      // Set only on the bot mount (verifyBot): the uid of the human who owns the
      // bot (robot.creator_uid, from the verify-bot reverse lookup). Absent for a
      // bot with no human creator. Used by the doc-create path to auto-grant the
      // owner admin so the bot's human owner can see docs the bot creates.
      botOwnerUid?: string
    }
  }
}

/** Extract the octo session token from the request (header `token` or Bearer). */
export function extractOctoToken(req: Request): string {
  const headerToken = req.header('token')
  if (headerToken) return headerToken
  const auth = req.header('authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return ''
}

/**
 * Require a valid octo identity; populates req.uid. 401 when missing/invalid.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractOctoToken(req)
  const identity = await getOctoIdentity().verifyToken(token)
  if (!identity) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  req.uid = identity.uid
  // Bots this human user owns (octo verify `owned_bots`). Defaults to [] when
  // absent so the owner=me listing never widens beyond the caller's own docs.
  req.ownedBots = identity.ownedBots ?? []
  // Stash the raw caller token so downstream handlers can authenticate their
  // own octo-server lookups (e.g. members.ts getUser). Never logged.
  req.octoToken = token
  next()
}
