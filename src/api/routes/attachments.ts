/**
 * Attachment presign endpoint STUB (§3.5).
 *   POST /api/v1/docs/{docId}/attachments/presign  (needs writer)
 *
 * Full flow (§3.5): front-end requests a presigned upload URL, uploads directly
 * to object storage, then the backend registers doc_attachment; reads re-issue
 * signed time-limited URLs. This round returns a stub presign response without
 * a real object-storage signature.
 *
 * TODO(§3.5): integrate COS/S3 SDK to mint a real presigned PUT URL, enforce
 * MIME/size validation, register doc_attachment, and re-sign read URLs.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { newAttachId } from '../../util/ids.js'
import { config } from '../../config/env.js'

export const attachmentsRouter = Router()

attachmentsRouter.post('/:docId/attachments/presign', async (req: Request, res: Response) => {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'writer')
  if (!guard) return
  const { fileName, mime, sizeBytes } = req.body ?? {}
  if (typeof fileName !== 'string' || fileName === '') {
    res.status(400).json({ error: 'fileName required' })
    return
  }
  const attachId = newAttachId()
  const objectKey = `${guard.meta.doc_id}/${attachId}/${fileName}`
  // STUB: a real implementation signs a PUT URL against config.attachments.bucket.
  res.status(200).json({
    attachId,
    objectKey,
    bucket: config.attachments.bucket,
    mime: typeof mime === 'string' ? mime : 'application/octet-stream',
    sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : 0,
    uploadUrl: `https://${config.attachments.bucket}.example-cos.invalid/${objectKey}?stub-presign=1`,
    note: 'STUB presign — not a valid signature (§3.5 TODO)',
  })
})
