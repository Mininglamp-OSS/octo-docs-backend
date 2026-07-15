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

/**
 * Derive the compile-root file extension from the image's ACTUAL magic bytes,
 * not its declared mime. Uploads can be mislabeled (e.g. a JPEG saved as
 * `111.png` and stored with mime image/png). typst picks its decoder from the
 * file extension, so a `.png` name over JPEG bytes fails with "Invalid PNG
 * signature" and aborts the whole compile. Naming the file by the sniffed
 * format lets typst decode it correctly. Returns null for bytes we don't
 * recognise (caller drops the image). Kept in sync with isSupportedImage.
 */
export function sniffImageExt(buf: Buffer): 'png' | 'jpg' | 'gif' | null {
  if (buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif'
  return null
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
async function resolveInputs(
  docId: string,
  referencedIds: ReadonlySet<string>,
): Promise<{
  attachments: Map<string, ResolvedAttachment>
  imagePaths: Map<string, string>
  images: TypstImageInput[]
}> {
  const store = getObjectStore()
  const ttl = config.attachments.readUrlTtlSeconds
  const attachments = new Map<string, ResolvedAttachment>()
  const imagePaths = new Map<string, string>()
  const images: TypstImageInput[] = []

  const { maxImageBytes, maxImageCount, maxImageTotalBytes } = config.typstExport
  const list = await docAttachmentRepo.listByDoc(docId)
  let imgIdx = 0
  let attempts = 0
  let totalBytes = 0
  for (const a of list) {
    const url = store.presignGet(a.objectKey, ttl)
    attachments.set(a.attachId, { url, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes })
    if (!a.mime.startsWith('image/')) continue
    // Only embed images the document actually references — never prefetch the
    // full attachment list (a doc can carry orphaned/unreferenced uploads).
    if (!referencedIds.has(a.attachId)) continue
    // Count bound: cap the number of download ATTEMPTS (not just successful
    // embeds) so a doc referencing many failing images can't force more than
    // maxImageCount downloads, each up to the per-image abort timeout.
    if (attempts >= maxImageCount) break
    attempts++
    // Skip anything whose declared size alone would blow the aggregate budget,
    // before spending a download on it.
    if (typeof a.sizeBytes === 'number' && a.sizeBytes > 0 && totalBytes + a.sizeBytes > maxImageTotalBytes) {
      continue
    }
    const bytes = await tryDownload(url, maxImageBytes)
    if (!bytes) continue // unfetchable host or oversize/failed — drop the image
    // Defensive: a corrupt or mislabeled (renamed non-image) object would abort
    // the WHOLE typst compile with a decode error. Sniff the magic bytes and
    // drop anything that isn't a real image, matching the best-effort intent
    // (a bad image is skipped, not fatal).
    const sniffedExt = sniffImageExt(bytes)
    if (!sniffedExt) continue
    // Aggregate byte budget: enforce on the real downloaded size too (a lying/
    // absent sizeBytes can't smuggle past the per-image cap into the total).
    if (totalBytes + bytes.byteLength > maxImageTotalBytes) continue
    totalBytes += bytes.byteLength
    const fileName = `img_${imgIdx++}.${sniffedExt}`
    imagePaths.set(a.attachId, fileName)
    images.push({ fileName, bytes })
  }
  return { attachments, imagePaths, images }
}

/**
 * Sniff the leading magic bytes to confirm a buffer is an image format the
 * pinned typst engine (v0.13.1) can actually decode: PNG, JPEG, or GIF.
 * (typst v0.13.1 also decodes SVG, but SVG is blocked at upload; and it does
 * NOT decode WebP or BMP — those raise `unknown image format` and would abort
 * the whole compile, which is exactly what this guard exists to prevent.)
 * Guards against a corrupt, renamed, or undecodable attachment sinking the
 * entire export; a rejected image is dropped like any other unresolved image.
 */
export function isSupportedImage(buf: Buffer): boolean {
  // Delegate to sniffImageExt so the accepted-format list and the extension
  // used for the compile-root filename can never drift apart. typst v0.13.1
  // decodes PNG/JPEG/GIF; WebP and BMP are intentionally rejected (they would
  // fail the whole compile). Revisit if TYPST_VERSION is bumped.
  return sniffImageExt(buf) !== null
}

/**
 * Collect the attachIds actually referenced by `image` nodes in the ProseMirror
 * document, so the export only downloads images the doc embeds — not every
 * attachment ever uploaded to it. Bounded DFS (shares the renderer's intent).
 */
export function collectReferencedAttachIds(pmJson: unknown): Set<string> {
  const ids = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown }
    if (n.type === 'image' && n.attrs && typeof n.attrs === 'object') {
      const id = (n.attrs as { attachId?: unknown }).attachId
      if (typeof id === 'string' && id) ids.add(id)
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c)
  }
  walk(pmJson)
  return ids
}

/**
 * Collect every unique raw `latex` string from inlineMath/blockMath nodes.
 * Used by the per-formula fallback: after a whole-document compile failure we
 * probe each unique formula in isolation to find the one(s) that actually break
 * Typst, so only those degrade to verbatim source and the rest stay real math.
 */
export function collectFormulaLatex(pmJson: unknown): string[] {
  const set = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown }
    if ((n.type === 'inlineMath' || n.type === 'blockMath') && n.attrs && typeof n.attrs === 'object') {
      const latex = (n.attrs as { latex?: unknown }).latex
      if (typeof latex === 'string' && latex) set.add(latex)
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c)
  }
  walk(pmJson)
  return [...set]
}

/**
 * Probe each unique formula by compiling it alone; return the set of formulas
 * whose isolated compile fails (i.e. the malformed ones). A probe doc is a
 * single block-math node, so a `TypstCompileError` is attributable to that one
 * formula.
 *
 * Bounded to protect the scarce compile pool: at most `maxProbes` formulas are
 * compiled and probing stops once `budgetMs` of wall-clock is spent. If the
 * work exceeds either bound the probe is abandoned (`exhausted: true`) so the
 * caller skips the partial retry and goes straight to the whole-document
 * verbatim fallback instead of holding a compile slot for hundreds of probes.
 * Non-compile errors abort probing too (treated as "can't attribute"), again
 * deferring to the whole-doc fallback.
 */
export async function probeFailingFormulas(
  latexList: string[],
  title: string,
  opts: { maxProbes: number; budgetMs: number },
): Promise<{ failing: Set<string>; exhausted: boolean }> {
  const failing = new Set<string>()
  const deadline = Date.now() + Math.max(0, opts.budgetMs)
  const limit = Math.max(0, opts.maxProbes)
  if (latexList.length > limit) return { failing, exhausted: true }
  let probed = 0
  for (const latex of latexList) {
    if (probed >= limit || Date.now() >= deadline) return { failing, exhausted: true }
    probed++
    const probeDoc = { type: 'doc', content: [{ type: 'blockMath', attrs: { latex } }] }
    try {
      const src = renderTypst(probeDoc, { title, attachments: new Map(), imagePaths: new Map() })
      await compileTypst(src, [])
    } catch (e) {
      if (e instanceof TypstCompileError) failing.add(latex)
      // A non-compile error (timeout, spawn failure, ...) means we can't safely
      // attribute the break to one formula: abandon probing and let the
      // whole-document verbatim fallback handle it.
      else return { failing, exhausted: true }
    }
  }
  return { failing, exhausted: false }
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
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader', { isBot: req.botToken !== undefined, token: req.octoToken })
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

    const referencedIds = collectReferencedAttachIds(pmJson)
    const { attachments, imagePaths, images } = await resolveInputs(docId, referencedIds)
    let pdf: Buffer
    try {
      const source = renderTypst(pmJson, { title: guard.meta.title, attachments, imagePaths })
      pdf = await compileTypst(source, images)
    } catch (compileErr) {
      // A single malformed formula can produce Typst-invalid math that fails the
      // whole compile (the per-formula JS-throw fallback can't catch a typst
      // non-zero exit). Isolate the culprit(s): probe each unique formula alone,
      // then re-render with ONLY the failing formulas verbatim so the rest of
      // the document still exports as real math. If that still fails (a
      // non-formula issue, or probing couldn't attribute it), fall back to the
      // whole-document verbatim retry as the final safety net.
      if (!(compileErr instanceof TypstCompileError)) throw compileErr
      // eslint-disable-next-line no-console
      console.warn(`[export:typst] compile failed for doc ${docId}; probing formulas for per-formula fallback`)
      const { failing: verbatimFormulas, exhausted } = await probeFailingFormulas(
        collectFormulaLatex(pmJson),
        guard.meta.title,
        { maxProbes: config.typstExport.maxFormulaProbes, budgetMs: config.typstExport.formulaProbeBudgetMs },
      )
      let partialPdf: Buffer | null = null
      if (!exhausted && verbatimFormulas.size > 0) {
        try {
          const partial = renderTypst(pmJson, {
            title: guard.meta.title,
            attachments,
            imagePaths,
            verbatimFormulas,
          })
          partialPdf = await compileTypst(partial, images)
          // eslint-disable-next-line no-console
          console.warn(`[export:typst] doc ${docId} recovered with ${verbatimFormulas.size} formula(s) verbatim`)
        } catch (partialErr) {
          if (!(partialErr instanceof TypstCompileError)) throw partialErr
        }
      }
      if (partialPdf) {
        pdf = partialPdf
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[export:typst] doc ${docId} per-formula fallback insufficient; whole-document verbatim retry`)
        const fallback = renderTypst(pmJson, {
          title: guard.meta.title,
          attachments,
          imagePaths,
          mathMode: 'verbatim',
        })
        pdf = await compileTypst(fallback, images)
      }
    }

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
