/**
 * Server-side .docx import (§ docx-import).
 *
 *   POST /:docId/import/docx   editor — parse an uploaded Word document into a
 *                              ProseMirror-JSON doc, uploading embedded images
 *                              into the doc's attachment store along the way.
 *
 * The raw .docx bytes arrive as an untrusted binary body (express.raw, scoped
 * to this route with a hard size cap). The zip extractor already enforces its
 * own bomb/oversize protection; this route adds the outer request-size ceiling
 * and a default-deny editor guard on top.
 *
 * Embedded images are streamed through a MediaUploadCtx that mirrors the
 * attachments presign+register flow: for each image the extractor keeps, we
 * mint an attachId, register a doc_attachment row, presign a PUT and upload the
 * bytes to object storage. The parser rewrites the image node to carry that
 * attachId; a failed / oversized / unrecognised image degrades to a
 * fileAttachment node instead of sinking the whole import.
 *
 * Parse failures (malformed zip, unreadable OOXML) return 422 import_failed and
 * are logged server-side without leaking any internal path or stack.
 */
import { Router, type Request, type Response } from 'express'
import express from 'express'
import { requireDocRole } from '../guard.js'
import { newAttachId } from '../../util/ids.js'
import { config } from '../../config/env.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { importDocxWithMedia } from '../../import/docx/index.js'
import { DocxUnsafeError } from '../../import/docx/extract.js'
import type { MediaUploadCtx } from '../../import/docx/media.js'

export const importRouter = Router()

/** MIME the browser sends for a .docx; octet-stream is accepted as a fallback. */
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Hard ceiling on the uploaded request body. The zip extractor enforces its own
 * (matching) upload + inflate/entry-count bomb protection downstream; this is the
 * outer transport bound so an oversized upload is rejected before it is buffered.
 * Sourced from the same config as the extractor so the two never drift.
 */
const MAX_UPLOAD_BYTES = config.docxImport.maxUploadBytes

/**
 * Reduce a client-supplied file name to a safe single path segment: strip any
 * directory components and reject '..' traversal so the object key can never
 * escape the `${docId}/${attachId}/` prefix. Mirrors attachments.ts.
 */
function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

/**
 * express.raw scoped to this route: accept the two content-types a .docx upload
 * can arrive as, buffer up to the hard cap, and reject anything larger with the
 * body-parser's own 413 (mapped by the central error handler).
 */
const rawDocxBody = express.raw({
  type: [DOCX_MIME, 'application/octet-stream'],
  limit: MAX_UPLOAD_BYTES,
})

importRouter.post('/:docId/import/docx', rawDocxBody, importDocxHandler)

export async function importDocxHandler(req: Request, res: Response): Promise<void> {
  // Import WRITES content into the doc → writer role, never reader. Default-deny.
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer')
  if (!guard) return

  // express.raw yields a Buffer only when the content-type matched; anything
  // else (wrong/absent content-type) leaves req.body as {} — treat as a 400.
  const buffer = req.body
  if (!Buffer.isBuffer(buffer)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  if (buffer.length === 0) {
    res.status(400).json({ error: 'empty_upload' })
    return
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: 'doc_too_large' })
    return
  }

  const docId = guard.meta.doc_id

  // MediaUploadCtx mirrors the attachments presign+register flow so embedded
  // images land in the same store/table as a normal upload. Failures degrade
  // in the parser (fileAttachment node) rather than throwing here.
  const uploadCtx: MediaUploadCtx = {
    docId,
    uid: req.uid!,
    maxImageBytes: config.attachments.maxImageSizeBytes,
    upload: async ({ bytes, mime, fileName }) => {
      const attachId = newAttachId()
      const safeName = sanitizeFileName(fileName)
      const objectKey = `${docId}/${attachId}/${safeName}`
      await docAttachmentRepo.register({
        attachId,
        docId,
        objectKey,
        mime,
        sizeBytes: bytes.length,
        fileName: safeName,
        createdBy: req.uid!,
      })
      const ttl = config.attachments.uploadUrlTtlSeconds
      const put = getObjectStore().presignPut(objectKey, mime, ttl)
      const resp = await fetch(put.uploadUrl, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': mime, ...(put.headers ?? {}) },
      })
      if (!resp.ok) {
        throw new Error(`attachment upload failed: ${resp.status}`)
      }
      return attachId
    },
  }

  try {
    const { doc, warnings } = await importDocxWithMedia(buffer, uploadCtx)
    res.status(200).json({ doc, warnings })
  } catch (err) {
    // A DocxUnsafeError means the extractor hit a hard safety bound (zip bomb,
    // oversize, too many entries, timeout, or malformed zip). It carries a
    // machine-readable `reason`; map it to a precise status so the client can
    // tell "this file is too big/complex" (413) from "this isn't a valid docx"
    // (400) instead of a generic parse failure. The message/path is never
    // leaked — only the stable error code + reason.
    if (err instanceof DocxUnsafeError) {
      // eslint-disable-next-line no-console
      console.warn(`[import:docx] unsafe upload for doc ${docId}: ${err.reason}`)
      const status =
        err.reason === 'not-a-zip' || err.reason === 'corrupt' || err.reason === 'timeout'
          ? 400
          : 413 // total/entry-too-large, ratio-too-high, too-many-entries, too-many-media
      res.status(status).json({ error: 'import_unsafe', reason: err.reason })
      return
    }
    // Malformed / unreadable OOXML beyond the zip layer lands here. Log
    // server-side without leaking any path or stack to the client; the parser
    // treats the whole file as untrusted, so a failure is the document's fault
    // (422), not ours.
    // eslint-disable-next-line no-console
    console.error(`[import:docx] parse failed for doc ${docId}:`, err)
    res.status(422).json({ error: 'import_failed' })
  }
}
