/**
 * POST /api/v1/docs/collab-token (§4.4).
 *
 * Mounted under /api/v1/docs. Unlike the other metadata routes, the uid here is
 * taken from the octo session token directly (the issuance service verifies it)
 * so it does NOT go through authMiddleware — it accepts the raw octo token and
 * returns 401 itself when identity is missing.
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
  const out = await issueCollabToken(octoToken, documentName)
  if (!out.ok) {
    res.status(out.status).json({ error: out.error })
    return
  }
  res.status(200).json(out.result)
})
