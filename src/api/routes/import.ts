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
import {
  acquireDocxImportSlot,
  releaseDocxImportSlot,
  DocxImportBusyError,
} from '../../import/docx/importQueue.js'
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
  // Reject a tampered array/non-string param up front (type confusion through
  // parameter tampering), then hand the raw params straight to requireDocRole
  // exactly as every other doc route does — the guard validates them and
  // returns the authoritative doc id from the DB for all downstream use.
  if (typeof req.params.docId !== 'string' || req.params.docId.length === 0) {
    res.status(400).json({ error: 'invalid_doc_id' })
    return
  }
  if (typeof req.uid !== 'string' || typeof req.spaceId !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }

  // Import WRITES content into the doc → writer role, never reader. Default-deny.
  const guard = await requireDocRole(res, req.uid, req.params.docId, req.spaceId, 'writer')
  if (!guard) return
  const uid = req.uid
  // express.raw yields a Buffer only when the content-type matched; anything
  // else (wrong/absent content-type, or a tampered body) leaves req.body as {}
  // or some other shape. Explicitly reject an array body first (CodeQL's
  // type-confusion barrier is an Array.isArray check), then require a real
  // Buffer before any length/size access so a non-Buffer body can never reach
  // the length checks.
  const rawBody: unknown = req.body
  if (Array.isArray(rawBody) || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const buffer: Buffer = rawBody
  const bufferLength: number = buffer.length
  if (bufferLength === 0) {
    res.status(400).json({ error: 'empty_upload' })
    return
  }
  // Defence-in-depth size cap. express.raw already rejects bodies over its
  // `limit`, but only fires when the content-type matched and the raw parser
  // actually ran; this explicit re-check guarantees an oversized buffer is
  // rejected here regardless of how it was buffered, using the same
  // MAX_UPLOAD_BYTES source so the two bounds never drift.
  if (bufferLength > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: 'doc_too_large' })
    return
  }

  // requireDocRole validated the param and returns the authoritative doc id
  // from the DB. Use THIS value — not the raw request param — for the object
  // key and all logging, so no user-controlled string flows into the store key
  // or a log format string (CodeQL: log-injection / externally-controlled
  // format string). It is a definite string sourced from trusted metadata.
  const docId = guard.meta.doc_id

  // Admission control: the parse/convert phase below is a synchronous,
  // CPU-heavy walk that holds an inflated document in memory. Bound how many
  // run at once — acquire a slot (queue if all busy) or shed load with 503 so
  // a burst of uploads cannot pin the event loop. Mirrors the pdfExport gate.
  try {
    await acquireDocxImportSlot()
  } catch (err) {
    if (err instanceof DocxImportBusyError) {
      // eslint-disable-next-line no-console
      console.warn('[import:docx] queue full for doc %s', docId)
      res.status(503).json({ error: 'import_busy' })
      return
    }
    throw err
  }

  // MediaUploadCtx mirrors the attachments presign+register flow so embedded
  // images land in the same store/table as a normal upload. Failures degrade
  // in the parser (fileAttachment node) rather than throwing here.
  const uploadCtx: MediaUploadCtx = {
    docId,
    uid,
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
        createdBy: uid,
      })
      const ttl = config.attachments.uploadUrlTtlSeconds
      const put = getObjectStore().presignPut(objectKey, mime, ttl)
      // Bound the PUT with a wall-clock timeout: this upload runs while holding a
      // docx-import concurrency slot, so a slow/wedged object store must not pin
      // the slot indefinitely and starve later imports into 503s.
      const resp = await fetch(put.uploadUrl, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': mime, ...(put.headers ?? {}) },
        signal: AbortSignal.timeout(config.docxImport.timeoutMs),
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
      console.warn('[import:docx] unsafe upload for doc %s: %s', docId, err.reason)
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
    console.error('[import:docx] parse failed for doc %s:', docId, err)
    res.status(422).json({ error: 'import_failed' })
  } finally {
    // Always hand the slot back, whether the import succeeded, failed, or the
    // parse deadline tripped — otherwise the queue leaks capacity permanently.
    releaseDocxImportSlot()
  }
}
