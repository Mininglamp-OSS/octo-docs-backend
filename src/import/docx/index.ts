/**
 * docx-import orchestrator: bytes → ProseMirror-JSON doc.
 *
 * Pipeline:
 *   ① extractDocx        untrusted zip → in-memory OOXML parts (bounded)
 *   ② parse + walk       document.xml + rels → PM block content
 *   ③ lists              consecutive numbered/bulleted/task paragraphs → nested
 *   ④ tables             w:tbl → table nodes (gridSpan/vMerge merges)
 *   ⑤ math               m:oMath → LaTeX on blockMath/inlineMath nodes
 *   ⑥ images             embedded media → attachId (async, via resolveImages)
 *
 * buildDocFromParts is pure/sync and produces a doc where images are still
 * placeholders (EMBED_REL_ATTR). resolveImages (async, needs docId + uploader)
 * turns those into real attachId image nodes — the route calls it with a live
 * object-store + attachment-repo uploader. Import stays usable without the
 * async step (placeholders simply degrade), which keeps the core testable.
 */
import { extractDocx, type ExtractedDocx, type ExtractedEntry } from './extract.js'
import { walkDocument, makeDeadline, type Deadline } from './document.js'
import { config } from '../../config/env.js'
import { parseRels } from './rels.js'
import { parseNumbering } from './numbering.js'
import { resolveImages, type MediaResolver, type MediaUploadCtx } from './media.js'
import type { PmNode } from './types.js'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema } from '../../schema/index.js'

export interface DocxImportResult {
  /** ProseMirror document — { type: 'doc', content: [...] }. */
  doc: PmNode
  /** Non-fatal notes surfaced to the user. */
  warnings: string[]
  /** rId → embedded media entry, for the async image-upload step. */
  media: MediaResolver
}

/**
 * Validate a produced doc against the editor's ProseMirror schema. Returns null
 * when valid; otherwise the validation error message. This is the "schema
 * 兑底" the pipeline promises: it catches any node/mark placed in an illegal
 * position (e.g. a block atom smuggled into inline content) BEFORE the doc ever
 * reaches setContent / y-prosemirror. Non-fatal by policy — the caller records a
 * warning rather than throwing, so a single bad region never sinks the import.
 */
export function validateAgainstSchema(doc: PmNode): string | null {
  try {
    const schema = buildSchema()
    PMNode.fromJSON(schema, doc as unknown as { [k: string]: unknown }).check()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Parse already-extracted parts into a PM doc (pure; no I/O). */
export function buildDocFromParts(extracted: ExtractedDocx, deadline?: Deadline): DocxImportResult {
  const warnings = [...extracted.warnings]

  const documentXml = extracted.parts.get('word/document.xml')?.data
  if (!documentXml) {
    return {
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
      warnings,
      media: () => null,
    }
  }

  const relsBuf = extracted.parts.get('word/_rels/document.xml.rels')?.data
  const rels = parseRels(relsBuf)

  const numbering = parseNumbering(extracted.parts.get('word/numbering.xml')?.data)

  const walked = walkDocument(documentXml, rels.targets, numbering, deadline)
  warnings.push(...walked.warnings)

  // rId → media entry: the rel Target for an image is e.g. "media/image1.png",
  // relative to word/, so we resolve it against the extracted word/media/* set.
  const mediaByName = new Map<string, ExtractedEntry>()
  for (const m of extracted.media) mediaByName.set(m.name, m)
  const media: MediaResolver = (relId: string) => {
    const target = rels.targets.get(relId)
    if (!target) return null
    // Normalise "media/imageN.png" / "/word/media/..." / "../media/..." to the
    // canonical extracted key "word/media/imageN.png".
    const file = target.replace(/\\/g, '/').split('/').pop() ?? ''
    return mediaByName.get(`word/media/${file.toLowerCase()}`) ?? null
  }

  return { doc: { type: 'doc', content: walked.content }, warnings, media }
}

/**
 * Full sync pipeline: raw .docx buffer → PM doc where images are still
 * PLACEHOLDERS (they carry a private `_embedRel` attr that is not a valid image
 * attr in the schema). This raw walker output must NOT be handed to setContent
 * as-is — go through importDocxWithMedia, which resolves the placeholders to
 * real image / fileAttachment nodes and then runs the schema check. Exposed on
 * its own only for tests and callers that resolve media themselves.
 */
export async function importDocx(buffer: Buffer): Promise<DocxImportResult> {
  const extracted = await extractDocx(buffer)
  // The extractor timeout only covers the zip inflate; give the synchronous
  // walk + OMML convert its own wall-clock budget from the same config so a
  // formula-dense / very wide document trips a `timeout` rather than pinning
  // the event loop. Sharing config.docxImport.timeoutMs keeps a single knob.
  return buildDocFromParts(extracted, makeDeadline(config.docxImport.timeoutMs))
}

/**
 * Full pipeline INCLUDING image upload. The route supplies the upload ctx
 * (object-store + attachment-repo bound); failed images degrade in place.
 */
export async function importDocxWithMedia(
  buffer: Buffer,
  uploadCtx: MediaUploadCtx,
): Promise<{ doc: PmNode; warnings: string[] }> {
  const result = await importDocx(buffer)
  const warnings = [...result.warnings]
  await resolveImages(result.doc, result.media, uploadCtx, warnings)
  // Schema 兜底: the doc is now final (image placeholders resolved to image /
  // fileAttachment nodes). Validate it against the editor schema so an illegal
  // node position is caught here, not at setContent time.
  const schemaError = validateAgainstSchema(result.doc)
  if (schemaError) warnings.push(`schema validation: ${schemaError}`)
  return { doc: result.doc, warnings }
}
