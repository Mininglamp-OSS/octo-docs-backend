/**
 * POST /api/v1/docs/collab-token (§4.4).
 *
 * Mounted under /api/v1/docs. Unlike the other metadata routes, the uid here is
 * taken from the octo session token directly (the issuance service verifies it)
 * so it does NOT go through authMiddleware — it accepts the raw octo token and
 * returns 401 itself when identity is missing.
 *
 * This route is mounted BEFORE spaceContextMiddleware, so it never gets a
 * required `req.spaceId`. It reads the `X-Space-Id` header OPTIONALLY here and
 * threads it to issueCollabToken purely for the recent-view fallback ingest, so
 * a document opened from a chat share link is recorded under the viewer's
 * current space (XIN-1237 space 口径统一). A missing header is not an error — the
 * ingest falls back to the document's home space.
 */
import { Router, type Request, type Response } from 'express'
import { issueCollabToken } from '../../auth/issueCollabToken.js'
import { extractOctoToken } from '../middleware/auth.js'

export const collabTokenRouter = Router()

collabTokenRouter.post('/collab-token', async (req: Request, res: Response) => {
  const { documentName } = req.body ?? {}
  if (typeof documentName !== 'string' || documentName === '') {
    res.status(400).json({ error: 'documentName required' })
    return
  }
  const octoToken = extractOctoToken(req)
  const rawSpace = req.header('X-Space-Id')
  const viewerSpaceId = typeof rawSpace === 'string' ? rawSpace.trim() : ''
  const out = await issueCollabToken(octoToken, documentName, viewerSpaceId)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.result)
})
