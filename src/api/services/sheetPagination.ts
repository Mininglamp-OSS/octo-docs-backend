/**
 * Cursor pagination for the sheet read surface (GET /:docId/sheet).
 *
 * Stage1 capped the whole-sheet read at config.sheetRead.maxCellBytes and
 * returned 413 sheet_too_large for anything larger — a sheet a bot could write
 * (chained PATCH batches) but never read back. This module lifts that hard wall
 * for opted-in callers: it slices the decoded, contract-validated cell map into
 * byte-bounded pages so an oversized grid becomes readable page by page, while
 * the legacy whole-sheet read stays byte-for-byte unchanged for callers that
 * pass no pagination params (backward compatible).
 *
 * WHY a cell cursor (not a row/column range): the payload is a FLAT Y.Map keyed
 * by the cross-repo `${sheetId}!${row}:${col}` contract (sheetConversion.ts), and
 * the grid is sparse — a row/column range would leave a caller to guess the
 * populated extents and could still hand back an unbounded page for one dense
 * row. Ordering the existing keys canonically by (sheetId, row, col) and paging
 * over them with an opaque cursor is the shape that fits the flat map: it needs
 * no extent metadata, is deterministic, works for a sparse grid, and lets each
 * page be bounded by the SAME byte cap the whole-sheet read already used — so no
 * single page can exceed maxCellBytes.
 *
 * SNAPSHOT CONSISTENCY across pages: each page is served from a fresh live read
 * (readLiveSheet), so a concurrent write between pages would otherwise stitch two
 * inconsistent snapshots together. The cursor embeds the baseVersion token of the
 * read that opened the walk; a page request whose embedded token no longer
 * matches the live baseVersion is rejected (the route maps it to 409
 * sheet_changed) so the caller restarts from page one against a single snapshot —
 * the read-side mirror of the write path's If-Match optimistic-concurrency guard.
 */
import type { SheetCell } from '../../agent/sheetConversion.js'

/** Decoded cell key parts, for canonical ordering. */
interface CellKeyParts {
  sheetId: string
  row: number
  col: number
}

/**
 * Parse a canonical `${sheetId}!${row}:${col}` key into its parts. Every key
 * reaching this module has already passed decodeSheetSnapshot's CELL_KEY_RE gate,
 * so a key that fails to parse here is a programming error, not writer input —
 * we return null and the caller treats it as sorting last (defensive, never
 * expected in practice).
 */
function parseCellKey(key: string): CellKeyParts | null {
  const bang = key.indexOf('!')
  if (bang <= 0) return null
  const sheetId = key.slice(0, bang)
  const rc = key.slice(bang + 1)
  const colon = rc.indexOf(':')
  if (colon <= 0) return null
  const row = Number(rc.slice(0, colon))
  const col = Number(rc.slice(colon + 1))
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null
  return { sheetId, row, col }
}

/**
 * Total order over cell keys: sheetId lexicographically, then row, then col
 * numerically (so `default!2:0` sorts before `default!10:0`, unlike a raw string
 * sort). This is the stable page order a cursor walks; it is deterministic for a
 * given snapshot so the same page boundaries reproduce across page requests.
 */
export function compareCellKeys(a: string, b: string): number {
  const pa = parseCellKey(a)
  const pb = parseCellKey(b)
  // Unparseable keys (never expected post-validation) sort last, deterministically.
  if (!pa || !pb) return pa ? -1 : pb ? 1 : (a < b ? -1 : a > b ? 1 : 0)
  if (pa.sheetId !== pb.sheetId) return pa.sheetId < pb.sheetId ? -1 : 1
  if (pa.row !== pb.row) return pa.row - pb.row
  if (pa.col !== pb.col) return pa.col - pb.col
  return 0
}

/** Sorted cell keys in canonical page order. */
export function sortedCellKeys(cells: Record<string, SheetCell>): string[] {
  return Object.keys(cells).sort(compareCellKeys)
}

/**
 * Opaque cursor payload: the baseVersion the walk was opened against + the last
 * cell key emitted so far. Encoded as base64url(JSON) so a caller treats it as
 * a single opaque token (never hand-constructs it).
 */
export interface SheetCursor {
  /** baseVersion token of the snapshot the walk started on (drift guard). */
  v: string
  /** Last cell key emitted; the next page starts strictly after it. */
  k: string
}

/** Encode a cursor to the opaque base64url token returned as `nextCursor`. */
export function encodeSheetCursor(cursor: SheetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Raised when a caller-supplied cursor is not a well-formed token (bad base64url,
 * bad JSON, or missing/blank fields). The route maps it to 400 invalid_cursor —
 * a client error distinct from 409 sheet_changed (a well-formed cursor whose
 * snapshot moved).
 */
export class InvalidSheetCursorError extends Error {
  readonly code = 'invalid_cursor'
  constructor(message: string) {
    super(`invalid_cursor: ${message}`)
    this.name = 'InvalidSheetCursorError'
  }
}

/**
 * Decode + validate an opaque cursor token, fail-closed. Throws
 * InvalidSheetCursorError on any malformation so a hostile or corrupt token can
 * never be silently treated as "start from the beginning".
 */
export function decodeSheetCursor(raw: string): SheetCursor {
  let json: string
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new InvalidSheetCursorError('not base64url')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new InvalidSheetCursorError('not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidSheetCursorError('not an object')
  }
  const rec = parsed as Record<string, unknown>
  if (typeof rec.v !== 'string' || rec.v === '' || typeof rec.k !== 'string' || rec.k === '') {
    throw new InvalidSheetCursorError('missing v/k')
  }
  return { v: rec.v, k: rec.k }
}

/** One page of cells plus the walk state needed to build the response. */
export interface SheetCellsPage {
  /** The cells in this page, as the same `{ key: cell }` map shape the whole-sheet read returns. */
  cells: Record<string, SheetCell>
  /** Last key emitted in this page (input to the next cursor); null when the page is empty. */
  lastKey: string | null
  /** True when cells remain after this page. */
  hasMore: boolean
}

/**
 * Slice the canonical cell order into one page, bounded by BOTH a cell `limit`
 * and a `maxBytes` payload cap. Emission stops when adding the next cell would
 * exceed either bound — except the first cell is always emitted so the walk
 * always makes progress (a single cell is already write-capped well under the
 * byte bound, so one cell never blows the cap in practice).
 *
 * @param cells    the full decoded, contract-validated cell map
 * @param afterKey emit only keys strictly after this one (null = first page)
 * @param limit    max cells in the page (> 0; the route clamps caller input)
 * @param maxBytes byte cap on the emitted cells' JSON payload (config.sheetRead.maxCellBytes)
 */
export function paginateSheetCells(
  cells: Record<string, SheetCell>,
  afterKey: string | null,
  limit: number,
  maxBytes: number,
): SheetCellsPage {
  const keys = sortedCellKeys(cells)
  // Start index: first key strictly greater than afterKey (binary-search-free;
  // the key count is bounded by the live doc's maxDocBytes cap upstream).
  let start = 0
  if (afterKey !== null) {
    while (start < keys.length && compareCellKeys(keys[start]!, afterKey) <= 0) start++
  }

  const page: Record<string, SheetCell> = {}
  let lastKey: string | null = null
  let bytes = 0
  let i = start
  for (; i < keys.length && Object.keys(page).length < limit; i++) {
    const key = keys[i]!
    const cell = cells[key]!
    // Measure this entry's contribution the same way the read body is measured:
    // the serialized `"key":value` pair. Always emit the first cell of a page so
    // progress is guaranteed even if one cell approaches the cap on its own.
    const entryBytes = Buffer.byteLength(JSON.stringify(key) + ':' + JSON.stringify(cell)) + 1
    if (Object.keys(page).length > 0 && bytes + entryBytes > maxBytes) break
    page[key] = cell
    bytes += entryBytes
    lastKey = key
  }

  const hasMore = i < keys.length
  return { cells: page, lastKey, hasMore }
}
