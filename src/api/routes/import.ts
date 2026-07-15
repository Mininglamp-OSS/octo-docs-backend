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
  // Route params are typed as string by Express, but harden against a crafted
  // request that makes a param non-string (type confusion) before it reaches
  // the guard / object-key construction. Default-deny on anything unexpected.
  const docIdParam = req.params.docId
  if (Array.isArray(docIdParam) || typeof docIdParam !== 'string' || docIdParam.length === 0) {
    res.status(400).json({ error: 'invalid_doc_id' })
    return
  }
  // Re-bind to a freshly typed `string` local (mirroring uid/spaceId below) so
  // the array/string narrowing is unambiguous to static dataflow before the
  // value flows into requireDocRole (CodeQL: type confusion through parameter
  // tampering). Passing the original param object here trips the analyzer even
  // though the guard above already default-denies a non-string.
  const docIdSafe: string = docIdParam
  // req.uid / req.spaceId are set by upstream auth middleware, but harden the
  // types here too so a crafted request cannot smuggle an array/object into the
  // guard (CodeQL: type confusion through parameter tampering). Default-deny.
  // Validate each value independently (not a combined `||`) and re-bind to a
  // freshly typed `string` local so the narrowing is unambiguous to both the
  // reader and static dataflow analysis before it flows into requireDocRole.
  const rawUid = req.uid
  if (Array.isArray(rawUid) || typeof rawUid !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  const rawSpaceId = req.spaceId
  if (Array.isArray(rawSpaceId) || typeof rawSpaceId !== 'string') {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  const uid: string = rawUid
  const spaceId: string = rawSpaceId

  // Import WRITES content into the doc → writer role, never reader. Default-deny.
  const guard = await requireDocRole(res, uid, docIdSafe, spaceId, 'writer')
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

  // Admission control: the parse/convert phase below is a synchronous,
  // CPU-heavy walk that holds an inflated document in memory. Bound how many
  // run at once — acquire a slot (queue if all busy) or shed load with 503 so
  // a burst of uploads cannot pin the event loop. Mirrors the pdfExport gate.
  try {
    await acquireDocxImportSlot()
  } catch (err) {
    if (err instanceof DocxImportBusyError) {
      // eslint-disable-next-line no-console
      console.warn(`[import:docx] queue full for doc ${docId}`)
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
  } finally {
    // Always hand the slot back, whether the import succeeded, failed, or the
    // parse deadline tripped — otherwise the queue leaks capacity permanently.
    releaseDocxImportSlot()
  }
}
