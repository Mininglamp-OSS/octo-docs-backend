/**
 * Attachment presign + read endpoints (§3.5).
 *   POST /api/v1/docs/{docId}/attachments/presign       (needs writer)
 *   GET  /api/v1/docs/{docId}/attachments/{attachId}     (needs reader)
 *
 * Flow (§3.5): the front-end requests a presigned upload URL, uploads the
 * binary directly to object storage (not through Hocuspocus), then the backend
 * registers a doc_attachment row. The Tiptap image node stores the `attach_id`
 * (or a controlled URL) — never base64 — so the Y.Doc stays small. At read time
 * the reference is exchanged for a freshly signed, time-limited GET URL.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { newAttachId } from '../../util/ids.js'
import { config } from '../../config/env.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'

export const attachmentsRouter = Router()

/** Allowed MIME entries from config (e.g. 'image/,application/pdf,text/plain'). */
function allowedMimeEntries(): string[] {
  return config.attachments.allowedMimePrefixes
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '')
}

/** Base MIME with any '; charset=...' parameter stripped, lower-cased. */
function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase()
}

/**
 * An allowed entry ending in '/' is a PREFIX match ('image/' -> image/png); an
 * entry without a trailing slash is an EXACT match. Exact matching is what keeps
 * a forged 'text/plaintext' / 'text/plain-x' from slipping past a bare
 * 'text/plain' entry (which a startsWith check would wrongly admit, §3.5 S5).
 */
function mimeAllowed(mime: string): boolean {
  const base = baseMime(mime)
  return allowedMimeEntries().some((entry) =>
    entry.endsWith('/') ? base.startsWith(entry) : base === entry,
  )
}

/**
 * Size tier is chosen by the backend from the 'image/' prefix (the same single
 * source of truth as the allow-list), never trusted from the client: 'image/'
 * -> image tier, everything else -> file tier. Both tiers hard-cap. The tier is
 * a UX/abuse constraint, not a security boundary (the declared mime is forgeable
 * — §3.5 S4); the real defences are the denylist + Content-Disposition + nosniff.
 */
function maxSizeFor(mime: string): number {
  return baseMime(mime).startsWith('image/')
    ? config.attachments.maxImageSizeBytes
    : config.attachments.maxFileSizeBytes
}

/** Types safe to render inline; everything else is forced to download (§3.5). */
function isInlineType(mime: string): boolean {
  const base = baseMime(mime)
  return base.startsWith('image/') || base === 'application/pdf'
}

/** Exact-match MIME denylist from config (e.g. 'image/svg+xml'). */
function blockedMimes(): string[] {
  return config.attachments.blockedMimes
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m !== '')
}

/**
 * A blocked MIME takes precedence over the allowed-prefix check. SVG in
 * particular matches the 'image/' prefix yet can embed <script>, so serving it
 * from our origin is an XSS vector — reject it at presign time.
 */
function mimeBlocked(mime: string): boolean {
  // Drop any '; charset=...' parameters before comparing.
  return blockedMimes().includes(baseMime(mime))
}

/**
 * Reduce a client-supplied file name to a safe single path segment: strip any
 * directory components and reject '..' traversal so the object key can never
 * escape the `${docId}/${attachId}/` prefix.
 */
function sanitizeFileName(fileName: string): string {
  // Take the last path segment regardless of '/' or '\' separators.
  const base = fileName.split(/[/\\]/).pop() ?? ''
  // Drop leading dots so '..' / '...' collapse to a safe name; allow a normal
  // extension dot to remain (e.g. 'photo.png').
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

/**
 * Make a stored (already path-sanitized) file name safe to embed inside a
 * `Content-Disposition: attachment; filename="..."` value: drop the quote,
 * backslash and control characters that could break out of the quoted-string.
 */
function dispositionFileName(fileName: string): string {
  const cleaned = fileName.replace(/[\p{Cc}"\\]/gu, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

attachmentsRouter.post('/:docId/attachments/presign', presignHandler)

export async function presignHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'writer')
  if (!guard) return

  const { fileName, mime, sizeBytes } = req.body ?? {}

  if (typeof fileName !== 'string' || fileName === '') {
    res.status(400).json({ error: 'fileName required' })
    return
  }
  if (typeof mime !== 'string') {
    res.status(400).json({
      error: 'mime_not_allowed',
      detail: `mime must be one of (prefix or exact): ${allowedMimeEntries().join(', ')}`,
    })
    return
  }
  // Denylist takes precedence over the allow-list (§3.5): a dangerous type is
  // reported as mime_blocked even when it is not (or partially) allowed, so
  // SVG/HTML/script/executable types never read as a mere "not allowed" miss.
  if (mimeBlocked(mime)) {
    res.status(400).json({
      error: 'mime_blocked',
      detail: `mime is not permitted: ${blockedMimes().join(', ')}`,
    })
    return
  }
  if (!mimeAllowed(mime)) {
    res.status(400).json({
      error: 'mime_not_allowed',
      detail: `mime must be one of (prefix or exact): ${allowedMimeEntries().join(', ')}`,
    })
    return
  }
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    res.status(400).json({ error: 'sizeBytes must be a positive number' })
    return
  }
  // Tiered cap chosen by mime prefix (image vs file); both tiers hard-cap.
  const maxSize = maxSizeFor(mime)
  if (sizeBytes > maxSize) {
    res.status(400).json({
      error: 'size_too_large',
      detail: `sizeBytes exceeds max of ${maxSize}`,
    })
    return
  }

  const docId = guard.meta.doc_id
  const attachId = newAttachId()
  const safeName = sanitizeFileName(fileName)
  // attach_id is unique, so the key is collision-free even for duplicate names.
  const objectKey = `${docId}/${attachId}/${safeName}`

  await docAttachmentRepo.register({
    attachId,
    docId,
    objectKey,
    mime,
    sizeBytes,
    fileName: safeName,
    createdBy: req.uid!,
  })

  const ttl = config.attachments.uploadUrlTtlSeconds
  const presigned = getObjectStore().presignPut(objectKey, mime, ttl)

  res.status(200).json({
    attachId,
    objectKey,
    bucket: config.attachments.bucket,
    mime,
    sizeBytes,
    uploadUrl: presigned.uploadUrl,
    headers: presigned.headers,
    expiresInSec: ttl,
  })
}

/**
 * Read-time signed URL exchange (§3.5 step 5): look up the attachment, confirm
 * it belongs to this doc, and return a freshly signed time-limited GET URL.
 */
attachmentsRouter.get('/:docId/attachments/:attachId', readHandler)

export async function readHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  const attachment = await docAttachmentRepo.getById(req.params.attachId!)
  // Hide cross-doc references behind 404 (do not leak existence to other docs).
  if (!attachment || attachment.docId !== guard.meta.doc_id) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const ttl = config.attachments.readUrlTtlSeconds
  // Non-inline types (anything but image/ and application/pdf) must download,
  // not render, in the browser — defends against forged HTML/script content
  // declared as an allowed type. The disposition is baked into the signed URL so
  // object storage replays it as the Content-Disposition response header (§3.5).
  const contentDisposition = isInlineType(attachment.mime)
    ? undefined
    : `attachment; filename="${dispositionFileName(attachment.fileName)}"`
  const url = getObjectStore().presignGet(attachment.objectKey, ttl, { contentDisposition })

  res.status(200).json({
    attachId: attachment.attachId,
    objectKey: attachment.objectKey,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    fileName: attachment.fileName,
    url,
    expiresInSec: ttl,
  })
}
