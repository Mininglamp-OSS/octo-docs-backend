/**
 * Server-side PDF export via Typst.
 *
 *   POST /:docId/export/pdf   reader — render the doc's persisted state to PDF
 *                              using the standalone `typst` binary.
 *
 * The document's authoritative persisted Y.Doc is converted to ProseMirror JSON,
 * rendered to Typst source (renderTypst.ts) and compiled to a PDF by a
 * short-lived sandboxed `typst` child process (typstService.ts). Unlike a
 * headless-browser renderer there is no resident process and no network access
 * at compile time, so image bytes are pre-downloaded (size-bounded) into the
 * compile root.
 * (renderTypst) -> `typst compile` (typstService) instead of HTML -> headless
 * Chrome. It exists so we can A/B the two backends on real documents (fidelity,
 * speed, memory) before choosing one.
 *
 * Images: Typst compiles OFFLINE (no network), so unlike the browser path we
 * cannot hand it signed URLs to fetch at render time. We pre-download each
 * image attachment's bytes here (size-bounded) and place them in the compile
 * root for `image()` to read. When a store driver serves attachments from a
 * non-fetchable synthetic host (the local-hmac dev driver's
 * `*.object-store.local`), the download is skipped and the image node is dropped
 * — exactly how the HTML path treats an unresolved attachment. In prod (S3/MinIO)
 * the signed GET URL is a real endpoint and the bytes embed normally.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { persistence } from '../../collab/persistence.js'
import { yDocStateToProsemirrorJSON } from '../../agent/conversion.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { config } from '../../config/env.js'
import { renderTypst, type ResolvedAttachment } from '../../export/renderTypst.js'
import {
  compileTypst,
  acquireSlot,
  releaseSlot,
  TypstQueueFullError,
  TypstTimeoutError,
  TypstCompileError,
  type TypstImageInput,
} from '../../export/typstService.js'

export const exportRouter = Router()

const EMPTY_DOC = { type: 'doc', content: [] }

/** Map an image mime to a file extension for the compile-root filename. */
function extForMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    case 'image/svg+xml': return 'svg'
    default: return 'bin'
  }
}

/**
 * Resolve every attachment to metadata, and attempt to download the bytes of
 * IMAGE attachments so Typst can embed them. Returns the attachment metadata map
 * (for the renderer), the attachId->local-filename map (for image() paths), and
 * the concrete image inputs (bytes) to place in the compile root.
 *
 * Non-image attachments are metadata-only (file cards render as text). Image
 * downloads are size-bounded and best-effort: a fetch failure (e.g. the dev
 * synthetic host) just drops that image, never fails the whole export.
 */
async function resolveInputs(docId: string): Promise<{
  attachments: Map<string, ResolvedAttachment>
  imagePaths: Map<string, string>
  images: TypstImageInput[]
}> {
  const store = getObjectStore()
  const ttl = config.attachments.readUrlTtlSeconds
  const attachments = new Map<string, ResolvedAttachment>()
  const imagePaths = new Map<string, string>()
  const images: TypstImageInput[] = []

  const list = await docAttachmentRepo.listByDoc(docId)
  let imgIdx = 0
  for (const a of list) {
    const url = store.presignGet(a.objectKey, ttl)
    attachments.set(a.attachId, { url, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes })
    if (!a.mime.startsWith('image/')) continue
    const bytes = await tryDownload(url, config.typstExport.maxImageBytes)
    if (!bytes) continue // unfetchable host or oversize/failed — drop the image
    const fileName = `img_${imgIdx++}.${extForMime(a.mime)}`
    imagePaths.set(a.attachId, fileName)
    images.push({ fileName, bytes })
  }
  return { attachments, imagePaths, images }
}

/**
 * Fetch up to maxBytes from a signed GET URL. Aborts and returns null on any
 * failure, non-200, or over-size body (streamed, so an oversize response can't
 * blow memory before the limit trips). A synthetic/dev host that isn't a real
 * endpoint simply throws and yields null.
 */
async function tryDownload(url: string, maxBytes: number): Promise<Buffer | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function contentDisposition(title: string): string {
  const base = title.trim() || '未命名文档'
  const encoded = encodeURIComponent(`${base}.pdf`)
  const ascii = base.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() || 'document'
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encoded}`
}

exportRouter.post('/:docId/export/pdf', exportPdfHandler)

export async function exportPdfHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader')
  if (!guard) return

  // Gate the whole pipeline (prep + compile) behind the queue, matching the
  // Gate the whole pipeline (prep + compile) behind the queue so heavy prep
  // (Yjs fetch, image downloads) must not run
  // unbounded ahead of the compile limit.
  try {
    await acquireSlot()
  } catch (err) {
    if (err instanceof TypstQueueFullError) {
      // eslint-disable-next-line no-console
      console.warn(`[export:typst] queue full for doc ${req.params.docId}`)
      res.status(503).json({ error: 'export_busy' })
      return
    }
    throw err
  }

  const docId = guard.meta.doc_id
  try {
    const state = await persistence.fetch(guard.meta.document_name)
    const pmJson = state ? yDocStateToProsemirrorJSON(state) : EMPTY_DOC

    const { attachments, imagePaths, images } = await resolveInputs(docId)
    const source = renderTypst(pmJson, { title: guard.meta.title, attachments, imagePaths })
    const pdf = await compileTypst(source, images)

    res.status(200)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', contentDisposition(guard.meta.title))
    res.setHeader('Content-Length', String(pdf.length))
    res.end(pdf)
  } catch (err) {
    if (err instanceof TypstTimeoutError) {
      // eslint-disable-next-line no-console
      console.error(`[export:typst] compile timed out for doc ${docId}`)
      res.status(504).json({ error: 'export_timeout' })
      return
    }
    if (err instanceof TypstCompileError) {
      // eslint-disable-next-line no-console
      console.error(`[export:typst] compile failed for doc ${docId}:`, err.message)
      res.status(500).json({ error: 'export_failed' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[export:typst] export failed for doc ${docId}:`, err)
    res.status(500).json({ error: 'export_failed' })
  } finally {
    releaseSlot()
  }
}
