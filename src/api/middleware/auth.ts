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
  // Stash the raw caller token so downstream handlers can authenticate their
  // own octo-server lookups (e.g. members.ts getUser). Never logged.
  req.octoToken = token
  next()
}
