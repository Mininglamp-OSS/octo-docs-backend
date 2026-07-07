/**
 * Server-side PDF export (§ export). Mounted under the authed /api/v1/docs API.
 *
 *   POST /:docId/export/pdf   reader — render the doc's persisted state to PDF
 *
 * The backend renders from its OWN authoritative copy of the document (the live
 * Y.Doc state), converts it to ProseMirror JSON with the shared schema, turns
 * that into standalone print HTML (renderHtml), and rasterises it to PDF with a
 * shared headless Chrome (pdfService). This is the WPS/Word-level path: real CJK,
 * server-side KaTeX math, emoji, selectable text, smart pagination — none of the
 * frontend jsPDF/html2canvas limits.
 *
 * v1 renders the PERSISTED copy, not the caller's unsaved buffer. Yjs autosaves
 * within a couple of seconds, so the export is at most slightly behind the live
 * cursor. If we later need exact-live fidelity, the frontend can POST ed.getJSON()
 * and this handler would prefer that body over the fetched state.
 *
 * Attachment URLs are minted HERE with the backend's own auth context (§3.5): the
 * doc's attachments are resolved to freshly signed, time-limited object-store GET
 * URLs and handed to renderHtml, so the headless browser can load images within
 * the signed window — and the pdfService request interceptor only allows those
 * object-store hosts.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { persistence } from '../../collab/persistence.js'
import { yDocStateToProsemirrorJSON } from '../../agent/conversion.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { config } from '../../config/env.js'
import { renderHtml, type ResolvedAttachment } from '../../export/renderHtml.js'
import { renderPdf, PdfQueueFullError, PdfTimeoutError, acquireSlot, releaseSlot } from '../../export/pdfService.js'

export const exportRouter = Router()

/** Empty ProseMirror document for a doc that has no persisted state yet. */
const EMPTY_DOC = { type: 'doc', content: [] }

/**
 * Resolve every attachment of the doc to a freshly signed, inline GET URL keyed
 * by attachId. Images embed the URL as their <img src>; the browser loads them
 * within the signed TTL. No Content-Disposition is set — images must render
 * inline, and the file-attachment / bookmark cards don't load a resource at all.
 */
async function resolveAttachments(docId: string): Promise<Map<string, ResolvedAttachment>> {
  const store = getObjectStore()
  const ttl = config.attachments.readUrlTtlSeconds
  const map = new Map<string, ResolvedAttachment>()
  for (const attachment of await docAttachmentRepo.listByDoc(docId)) {
    map.set(attachment.attachId, {
      url: store.presignGet(attachment.objectKey, ttl),
      fileName: attachment.fileName,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
    })
  }
  return map
}

/**
 * Build a Content-Disposition value with a CJK-safe filename. The RFC 5987
 * `filename*` carries the UTF-8 percent-encoded title; a stripped ASCII
 * `filename` is the fallback for the rare client that ignores `filename*`.
 */
function contentDisposition(title: string): string {
  const base = title.trim() || '未命名文档'
  const encoded = encodeURIComponent(`${base}.pdf`)
  // ASCII fallback: drop non-ASCII and characters that break the quoted-string.
  const ascii = base.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() || 'document'
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encoded}`
}

exportRouter.post('/:docId/export/pdf', exportPdfHandler)

export async function exportPdfHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  // Acquire the concurrency slot BEFORE any heavy work (Yjs fetch, attachment
  // resolution, HTML rendering). Previously the slot was only acquired inside
  // renderPdf(), so a burst could exhaust DB/CPU/memory on preparation before
  // the queue had any effect. Now the entire pipeline is gated.
  try {
    await acquireSlot()
  } catch (err) {
    if (err instanceof PdfQueueFullError) {
      // eslint-disable-next-line no-console
      console.warn(`[export] queue full for doc ${req.params.docId}`)
      res.status(503).json({ error: 'export_busy' })
      return
    }
    throw err
  }

  const docId = guard.meta.doc_id
  try {
    // Load the authoritative persisted state -> ProseMirror JSON. A doc with no
    // edits yet has no yjs_document row; render an empty document.
    const state = await persistence.fetch(guard.meta.document_name)
    const pmJson = state ? yDocStateToProsemirrorJSON(state) : EMPTY_DOC

    const attachments = await resolveAttachments(docId)
    const html = renderHtml(pmJson, { title: guard.meta.title, attachments })
    const pdf = await renderPdf(html, true)

    res.status(200)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', contentDisposition(guard.meta.title))
    res.setHeader('Content-Length', String(pdf.length))
    res.end(pdf)
  } catch (err) {
    if (err instanceof PdfTimeoutError) {
      // eslint-disable-next-line no-console
      console.error(`[export] pdf render timed out for doc ${docId}`)
      res.status(504).json({ error: 'export_timeout' })
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[export] pdf render failed for doc ${docId}:`, err)
    res.status(500).json({ error: 'export_failed' })
  } finally {
    releaseSlot()
  }
}
