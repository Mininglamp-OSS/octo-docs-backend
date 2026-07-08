/**
 * Express REST app (§8.4). All endpoints mounted under /api/v1/docs/*.
 *
 * Mount order:
 *   1. public routes (collab-token, invite accept) — verify octo identity
 *      themselves and return their own 401, so they are mounted BEFORE
 *      authMiddleware.
 *   2. authMiddleware (octo identity -> req.uid) for the metadata operations.
 *   3. spaceContextMiddleware (X-Space-Id header -> req.spaceId) for the
 *      metadata operations; a missing header is a hard 400.
 *   4. metadata routers (docs / members / invites-admin / attachments).
 *
 * A second, bot-facing mount (§ v4.3) re-mounts the same metadata routers under
 * /v1/bot/docs behind verifyBot (bot token -> req.uid + server-resolved
 * req.spaceId) instead of authMiddleware + spaceContextMiddleware. The human
 * mount below is unchanged.
 */
import express, { type Express, Router, type Request, type Response, type NextFunction } from 'express'
import { config } from '../config/env.js'
import { authMiddleware } from './middleware/auth.js'
import { spaceContextMiddleware } from './middleware/spaceContext.js'
import { verifyBotMiddleware } from './middleware/verifyBot.js'
import { createRateLimiter, type RateLimiterOptions } from './middleware/rateLimit.js'
import { collabTokenRouter } from './routes/collabToken.js'
import { docsRouter } from './routes/docs.js'
import { membersRouter } from './routes/members.js'
import { forwardGrantRouter } from './routes/forwardGrant.js'
import { accessRequestsRouter } from './routes/accessRequests.js'
import { invitesRouter, acceptInviteRouter } from './routes/invites.js'
import { attachmentsRouter } from './routes/attachments.js'
import { linkCardRouter } from './routes/linkCard.js'
import { commentsRouter } from './routes/comments.js'
import { versionsRouter } from './routes/versions.js'

export function createApp(opts: { rateLimit?: RateLimiterOptions; trustProxy?: boolean | number | string } = {}): Express {
  const app = express()

  // Trust the reverse proxy (nginx) in front of us so req.ip — and therefore the
  // per-IP rate limiter below — reflects the real client from X-Forwarded-For
  // rather than the proxy address. Configurable per deployment (config.trustProxy).
  app.set('trust proxy', opts.trustProxy ?? config.trustProxy)

  app.use(express.json({ limit: '1mb' }))

  // health check (no auth, and deliberately mounted BEFORE any rate limiter so
  // liveness/readiness probes are never throttled)
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  const api = Router()

  // 0. per-IP rate limit for the whole human chain (§8.4). Mounted first so it
  //    also covers the public collab-token / invite-accept routes below and the
  //    authorizing metadata routers.
  api.use(createRateLimiter(opts.rateLimit))

  // 1. public (identity verified inside the handler/service)
  api.use(collabTokenRouter) // POST /collab-token
  api.use(acceptInviteRouter) // POST /invites/:inviteToken/accept

  // 2. require octo identity for everything below
  api.use(authMiddleware)

  // 3. require a space context (X-Space-Id header) for the metadata operations
  api.use(spaceContextMiddleware)

  // 4. metadata operations
  api.use(docsRouter) // / , /:docId
  api.use(membersRouter) // /:docId/members ...
  api.use(forwardGrantRouter) // /:docId/forward-grant (forward-to-chat authorization, max-merge)
  api.use(accessRequestsRouter) // /:docId/access-requests ... (screen 4c request/approve/deny)
  api.use(invitesRouter) // /:docId/invites ... (admin)
  api.use(attachmentsRouter) // /:docId/attachments/presign , /:docId/attachments/:attachId
  api.use(linkCardRouter) // /:docId/link-card (OG fetch, §3.5 ⑰)
  api.use(commentsRouter) // /:docId/comments , /:docId/comments/:id
  api.use(versionsRouter) // /:docId/versions ... (snapshot + restore, §4 #4)

  app.use('/api/v1/docs', api)

  // Bot-facing entry (§ v4.3): the SAME nine metadata routers, re-mounted behind
  // a bot identity middleware at a physically distinct prefix so nginx can route
  // /v1/bot/docs -> docs-backend while other /v1/bot/* -> octo-server. No handler
  // code is copied or forked — each router only reads req.uid / req.spaceId, both
  // of which verifyBot injects (uid from the bot token, spaceId from octo-server's
  // server-side reverse lookup). Deliberately excludes the public collab-token /
  // invite-accept routes (those are a separate user-token path) and does NOT mount
  // spaceContextMiddleware — the bot space is server-resolved, never header-driven.
  const botApi = Router()
  // Same per-IP rate limit for the bot chain (independent budget from the human
  // mount), mounted ahead of verifyBot so the authorizing bot routes are covered.
  botApi.use(createRateLimiter(opts.rateLimit))
  botApi.use(verifyBotMiddleware)
  botApi.use(docsRouter)
  botApi.use(membersRouter)
  botApi.use(forwardGrantRouter)
  botApi.use(accessRequestsRouter)
  botApi.use(invitesRouter)
  botApi.use(attachmentsRouter)
  botApi.use(linkCardRouter)
  botApi.use(commentsRouter)
  botApi.use(versionsRouter)
  app.use('/v1/bot/docs', botApi)

  // central error handler — unexpected errors => 500 (§8.4 error table).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('REST error:', err)
    if (res.headersSent) return
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}
