/**
 * SpaceContext middleware (strict by-space isolation, P1).
 *
 * The isolation boundary is the frontend-injected `X-Space-Id` header. This
 * middleware reads it, trims it, and stashes the result on `req.spaceId` for the
 * downstream metadata handlers to scope their queries by. A missing or empty
 * header is a hard 400 (`{ error: 'space_required' }`) — there is no warn/grace
 * mode: the isolation is enforced from the first request.
 *
 * Mount order: AFTER authMiddleware (so req.uid is already resolved) and BEFORE
 * the metadata routers. The public routes (collab-token, invite accept) are
 * mounted ahead of authMiddleware and therefore never reach this middleware, so
 * they keep working without a space header.
 */
import type { Request, Response, NextFunction } from 'express'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      spaceId?: string
    }
  }
}

/** Require an `X-Space-Id` header; populates req.spaceId. 400 when missing/empty. */
export function spaceContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header('X-Space-Id')
  const spaceId = typeof raw === 'string' ? raw.trim() : ''
  if (spaceId === '') {
    res.status(400).json({ error: 'space_required' })
    return
  }
  req.spaceId = spaceId
  next()
}
