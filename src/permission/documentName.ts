/**
 * documentName parsing and construction (§4.1 step 5 / §8.1 / appendix B).
 *
 * documentName format: `octo:{space}:{folder}:{doc}` (4 segments).
 * Whiteboard key: `octo:{space}:{folder}:wb:{board}` (5 segments, parts[3]==='wb').
 *
 * parseDocumentName runs an EXECUTABLE validation matrix and REJECTS invalid
 * input (it does NOT do best-effort parsing):
 *   a. asymmetric whiteboard discriminator: 5 segments && parts[3]==='wb' =>
 *      whiteboard key (the document backend does not serve whiteboards).
 *   b. document key must be EXACTLY 4 segments.
 *   c. first segment must === 'octo'.
 *   d. empty segments rejected.
 *   e. {doc} must not contain illegal chars (incl ':') and must not equal 'wb'.
 */

const SEG = /^[A-Za-z0-9_-]+$/

export interface ParsedDocument {
  kind: 'document'
  space: string
  folder: string
  doc: string
}

export interface ParsedWhiteboard {
  kind: 'whiteboard'
  space: string
  folder: string
  board: string
}

export type ParsedName = ParsedDocument | ParsedWhiteboard

export class DocumentNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentNameError'
  }
}

/**
 * Parse and validate a documentName. Throws DocumentNameError on any invalid
 * shape. Whiteboard keys parse to { kind: 'whiteboard' } so callers can reject
 * them explicitly (§4.1 step 5: white-board keys => 4403/4404).
 */
export function parseDocumentName(name: string): ParsedName {
  const parts = name.split(':')

  if (parts[0] !== 'octo') throw new DocumentNameError('bad ns') // first segment must be 'octo'

  // 5 segments && parts[3] === 'wb' => whiteboard key (asymmetric discriminator).
  if (parts.length === 5 && parts[3] === 'wb') {
    const [, space, folder, , board] = parts
    if (![space, folder, board].every((s) => s !== undefined && SEG.test(s))) {
      throw new DocumentNameError('bad seg')
    }
    return { kind: 'whiteboard', space: space!, folder: folder!, board: board! }
  }

  // Otherwise must be EXACTLY 4 segments => document key.
  if (parts.length === 4) {
    const [, space, folder, doc] = parts
    if (![space, folder, doc].every((s) => s !== undefined && SEG.test(s))) {
      throw new DocumentNameError('bad seg')
    }
    if (doc === 'wb') {
      throw new DocumentNameError('doc segment must not be "wb" (ambiguous with whiteboard prefix)')
    }
    return { kind: 'document', space: space!, folder: folder!, doc: doc! }
  }

  throw new DocumentNameError('bad documentName: segment count')
}

/**
 * Build a documentName for a document key (§8.1). Validates each segment so we
 * never persist a key that parseDocumentName would later reject.
 */
export function buildDocumentName(space: string, folder: string, doc: string): string {
  for (const [label, seg] of [
    ['space', space],
    ['folder', folder],
    ['doc', doc],
  ] as const) {
    if (!SEG.test(seg)) throw new DocumentNameError(`invalid ${label} segment: ${seg}`)
  }
  if (doc === 'wb') throw new DocumentNameError('doc segment must not be "wb"')
  return `octo:${space}:${folder}:${doc}`
}
