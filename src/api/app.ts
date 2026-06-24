/**
 * Express REST app (§8.4). All endpoints mounted under /api/v1/docs/*.
 *
 * Mount order:
 *   1. public routes (collab-token, invite accept) — verify octo identity
 *      themselves and return their own 401, so they are mounted BEFORE
 *      authMiddleware.
 *   2. authMiddleware (octo identity -> req.uid) for the metadata operations.
 *   3. metadata routers (docs / members / invites-admin / attachments).
 */
import express, { type Express, Router, type Request, type Response, type NextFunction } from 'express'
import { authMiddleware } from './middleware/auth.js'
import { collabTokenRouter } from './routes/collabToken.js'
import { docsRouter } from './routes/docs.js'
import { membersRouter } from './routes/members.js'
import { invitesRouter, acceptInviteRouter } from './routes/invites.js'
import { attachmentsRouter } from './routes/attachments.js'
import { linkCardRouter } from './routes/linkCard.js'
import { commentsRouter } from './routes/comments.js'
import { versionsRouter } from './routes/versions.js'

export function createApp(): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // health check (no auth)
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  const api = Router()

  // 1. public (identity verified inside the handler/service)
  api.use(collabTokenRouter) // POST /collab-token
  api.use(acceptInviteRouter) // POST /invites/:inviteToken/accept

  // 2. require octo identity for everything below
  api.use(authMiddleware)

  // 3. metadata operations
  api.use(docsRouter) // / , /:docId
  api.use(membersRouter) // /:docId/members ...
  api.use(invitesRouter) // /:docId/invites ... (admin)
  api.use(attachmentsRouter) // /:docId/attachments/presign , /:docId/attachments/:attachId
  api.use(linkCardRouter) // /:docId/link-card (OG fetch, §3.5 ⑰)
  api.use(commentsRouter) // /:docId/comments , /:docId/comments/:id
  api.use(versionsRouter) // /:docId/versions ... (snapshot + restore, §4 #4)

  app.use('/api/v1/docs', api)

  // central error handler — unexpected errors => 500 (§8.4 error table).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('REST error:', err)
    if (res.headersSent) return
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}
