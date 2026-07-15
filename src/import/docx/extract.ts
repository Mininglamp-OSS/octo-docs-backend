/**
 * Safe DOCX (OOXML zip) extraction layer — the untrusted-input boundary for the
 * whole docx-import pipeline (commit ①).
 *
 * A .docx is a ZIP of XML parts + media. Anything the user uploads is hostile
 * until proven otherwise, so this module inflates entries entirely IN MEMORY and
 * refuses to touch the filesystem. That single choice removes an entire class of
 * attacks for free:
 *
 *   - zip-slip (`../../etc/passwd`)      — we never resolve an entry name to a path
 *   - symlink escape                     — we never create a symlink on disk
 *   - device/special-file writes         — nothing is ever written
 *
 * What still has to be defended explicitly (bytes + time + count, all bounded by
 * config.docxImport):
 *
 *   - zip bomb (size)      — total + per-entry uncompressed ceilings, tracked as
 *                            each entry inflates; aborts the instant one is crossed
 *   - zip bomb (ratio)     — per-entry uncompressed/compressed ratio ceiling, so a
 *                            crafted member is rejected before it fully inflates
 *   - zip bomb (CPU/time)  — a hard wall-clock timeout over the whole extract; a
 *                            pathological archive burns time, not just bytes
 *   - entry-count DoS      — max entries (millions of tiny members)
 *   - media flooding       — max media files accepted
 *
 * Output is an in-memory map of ONLY the OOXML parts the importer cares about
 * (document.xml, the rels, numbering/styles, and word/media/*). Unknown members
 * are counted (for the limits) but their bytes are discarded — default-deny.
 */
import yauzl, { type ZipFile, type Entry } from 'yauzl'
import { config } from '../../config/env.js'

/** A single extracted, fully-inflated zip member we chose to keep. */
export interface ExtractedEntry {
  /** Normalised (forward-slash) entry name, e.g. `word/document.xml`. */
  name: string
  /** Fully inflated bytes. Bounded by maxEntryUncompressedBytes. */
  data: Buffer
}

/** The subset of a .docx the importer needs, keyed by normalised entry name. */
export interface ExtractedDocx {
  /** Every kept part keyed by normalised name (lower-cased for lookup safety). */
  parts: Map<string, ExtractedEntry>
  /** word/media/* entries in archive order (images, embeddings). */
  media: ExtractedEntry[]
  /** Non-fatal notes (e.g. entries skipped for being outside the allowlist). */
  warnings: string[]
}

/** Raised when the archive violates a hard safety bound. Maps to HTTP 4xx/413. */
export class DocxUnsafeError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason for the route to map to a status/i18n key. */
    readonly reason:
      | 'not-a-zip'
      | 'too-many-entries'
      | 'entry-too-large'
      | 'total-too-large'
      | 'ratio-too-high'
      | 'too-many-media'
      | 'timeout'
      | 'corrupt',
  ) {
    super(message)
    this.name = 'DocxUnsafeError'
  }
}

/**
 * Which entries we keep. Everything else is counted (limits) then discarded.
 * Kept parts are the minimum the importer reads:
 *   - word/document.xml            the body
 *   - word/_rels/document.xml.rels hyperlink + image relationships
 *   - word/numbering.xml           list definitions (numId → format/ilvl)
 *   - word/styles.xml              named styles (Heading1, Quote, Code, …)
 *   - [Content_Types].xml          media content-type map
 *   - word/media/*                 embedded binaries (images)
 */
function isWantedPart(name: string): boolean {
  return (
    name === 'word/document.xml' ||
    name === 'word/_rels/document.xml.rels' ||
    name === 'word/numbering.xml' ||
    name === 'word/styles.xml' ||
    name === '[content_types].xml'
  )
}

function isMedia(name: string): boolean {
  return name.startsWith('word/media/')
}

/** Normalise an entry name: backslashes → slashes, collapse, lower-case. */
function normaliseName(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

/**
 * Extract a .docx buffer into the in-memory parts we care about, enforcing every
 * config.docxImport bound. Rejects (DocxUnsafeError) the moment any limit is
 * crossed. Never writes to disk.
 */
export function extractDocx(buffer: Buffer): Promise<ExtractedDocx> {
  const limits = config.docxImport
  const deadline = Date.now() + limits.timeoutMs

  return new Promise<ExtractedDocx>((resolve, reject) => {
    // Guards against double-settle + fd leak (lesson from the adopt-zip work).
    let settled = false
    let zip: ZipFile | null = null

    const finish = (err: Error | null, value?: ExtractedDocx): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        zip?.close()
      } catch {
        /* already closed */
      }
      if (err) reject(err)
      else resolve(value!)
    }

    // Hard wall-clock ceiling over the WHOLE extract (CPU/time zip-bomb defence).
    const timer = setTimeout(() => {
      finish(new DocxUnsafeError('docx extraction timed out', 'timeout'))
    }, limits.timeoutMs)

    // lazyEntries: we pull entries one at a time so we can abort mid-archive the
    // instant a bound is crossed, instead of eagerly decompressing everything.
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) {
        finish(new DocxUnsafeError('not a valid zip / docx', 'not-a-zip'))
        return
      }
      zip = zf

      const parts = new Map<string, ExtractedEntry>()
      const media: ExtractedEntry[] = []
      const warnings: string[] = []
      let entryCount = 0
      let totalUncompressed = 0

      const overDeadline = (): boolean => Date.now() > deadline

      zf.on('entry', (entry: Entry) => {
        if (settled) return
        if (overDeadline()) {
          finish(new DocxUnsafeError('docx extraction timed out', 'timeout'))
          return
        }

        entryCount += 1
        if (entryCount > limits.maxEntries) {
          finish(new DocxUnsafeError(`too many zip entries (> ${limits.maxEntries})`, 'too-many-entries'))
          return
        }

        const name = normaliseName(entry.fileName)

        // Directory entries carry no content — skip without inflating.
        if (name.endsWith('/')) {
          zf.readEntry()
          return
        }

        const compressed = entry.compressedSize
        const uncompressed = entry.uncompressedSize

        // Per-entry uncompressed ceiling (one crafted member can't exhaust RAM).
        if (uncompressed > limits.maxEntryUncompressedBytes) {
          finish(new DocxUnsafeError(`zip entry too large: ${name}`, 'entry-too-large'))
          return
        }
        // Running total ceiling (primary zip-bomb defence).
        if (totalUncompressed + uncompressed > limits.maxTotalUncompressedBytes) {
          finish(new DocxUnsafeError('total uncompressed size exceeds limit', 'total-too-large'))
          return
        }
        // Compression-ratio ceiling — flags a bomb before it fully inflates.
        // (compressed 0 is legit for stored/empty entries; skip the ratio test.)
        if (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio) {
          finish(new DocxUnsafeError(`suspicious compression ratio: ${name}`, 'ratio-too-high'))
          return
        }

        const wanted = isWantedPart(name)
        const mediaEntry = isMedia(name)

        // Not a part we keep: count it against the bounds (already done) then
        // discard its bytes without inflating — default-deny, cheap.
        if (!wanted && !mediaEntry) {
          totalUncompressed += uncompressed
          zf.readEntry()
          return
        }

        if (mediaEntry && media.length >= limits.maxMediaFiles) {
          finish(new DocxUnsafeError(`too many media files (> ${limits.maxMediaFiles})`, 'too-many-media'))
          return
        }

        zf.openReadStream(entry, (streamErr, stream) => {
          if (settled) return
          if (streamErr || !stream) {
            finish(new DocxUnsafeError(`failed to read entry: ${name}`, 'corrupt'))
            return
          }

          const chunks: Buffer[] = []
          let read = 0

          stream.on('data', (chunk: Buffer) => {
            read += chunk.length
            // Defend even if the header lied about uncompressedSize: cap on the
            // ACTUAL inflated bytes, both per-entry and against the total.
            if (read > limits.maxEntryUncompressedBytes) {
              stream.destroy()
              finish(new DocxUnsafeError(`zip entry inflated past limit: ${name}`, 'entry-too-large'))
              return
            }
            if (totalUncompressed + read > limits.maxTotalUncompressedBytes) {
              stream.destroy()
              finish(new DocxUnsafeError('total inflated size exceeds limit', 'total-too-large'))
              return
            }
            chunks.push(chunk)
          })

          stream.on('error', () => {
            finish(new DocxUnsafeError(`stream error on entry: ${name}`, 'corrupt'))
          })

          stream.on('end', () => {
            if (settled) return
            totalUncompressed += read
            const kept: ExtractedEntry = { name, data: Buffer.concat(chunks) }
            if (mediaEntry) media.push(kept)
            else parts.set(name, kept)
            if (overDeadline()) {
              finish(new DocxUnsafeError('docx extraction timed out', 'timeout'))
              return
            }
            zf.readEntry()
          })
        })
      })

      zf.on('end', () => {
        if (!parts.has('word/document.xml')) {
          warnings.push('word/document.xml missing — not a well-formed docx body')
        }
        finish(null, { parts, media, warnings })
      })

      zf.on('error', () => {
        finish(new DocxUnsafeError('corrupt zip archive', 'corrupt'))
      })

      zf.readEntry()
    })
  })
}
