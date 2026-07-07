/**
 * verifyBot middleware — bot-facing entry (§ v4.3 bot docs API).
 *
 * The bot entry re-mounts the same metadata routers as the human `/api/v1/docs`
 * chain, but swaps identity resolution: instead of authMiddleware +
 * spaceContextMiddleware, a single verifyBot resolves the incoming bot bearer
 * token against octo-server's existing POST /v1/auth/verify-bot and injects the
 * trusted identity server-side.
 *
 * It differs from the human chain in three deliberate ways:
 *   1. It sets BOTH req.uid (= bot uid) and req.spaceId (= the space octo-server
 *      reverse-resolved from the bot's space_member row). No spaceContextMiddleware
 *      is mounted on the bot path.
 *   2. It MUST NOT read or trust a client-supplied `X-Space-Id` header — the space
 *      is only ever the server-side reverse lookup (anti-spoof).
 *   3. It MUST NOT set req.octoToken. The bot path has no caller session token;
 *      downstream octo-server lookups (the anti ghost-member existence check in
 *      members/forwardGrant) rely on the configured OCTO_SERVER_TOKEN serviceToken
 *      instead. This is why serviceToken is a deploy prerequisite for the bot path.
 *
 * Mount order: FIRST on the bot router, before any metadata router. On verify
 * failure return 401 (same envelope as authMiddleware).
 */
import type { Request, Response, NextFunction } from 'express'
import { extractOctoToken } from './auth.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'

/**
 * Require a valid bot identity; populates req.uid and req.spaceId from the
 * server-side verify-bot reverse lookup. 401 when the token is missing/invalid.
 */
export async function verifyBotMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractOctoToken(req)
  const identity = await getOctoIdentity().verifyBot(token)
  if (!identity) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  req.uid = identity.uid
  // Space comes solely from the server-side reverse lookup; any client X-Space-Id
  // is deliberately ignored here (anti-spoof).
  req.spaceId = identity.spaceId
  // Intentionally NOT setting req.octoToken: the bot path authenticates its
  // octo-server lookups with the configured serviceToken, never a caller token.
  next()
}
