/**
 * Server-side (no-DOM) spreadsheet <-> Y.Doc helpers for Agent (bot) access (§7.x).
 *
 * The sheet counterpart of conversion.ts. Where documents need a ProseMirror
 * round-trip, a spreadsheet's payload is a plain Y.Map, so a bot reads/writes it
 * directly — no schema, no DOM.
 *
 * CROSS-REPO CONTRACT — these MUST match octo-web/packages/docs/src/sheet/binding.ts:
 *   - Y.Map field name on the Y.Doc: 'sheet'
 *   - cell key: `${sheetId}!${row}:${col}`
 *   - cell value: { v?: string|number|boolean|null, f?: string, s?: object }
 * (Same discipline as COLLAB_FIELD, which is shared between this backend and the
 * frontend.) If the frontend changes the field name or key shape, change it here
 * in lockstep or bot edits land in a Y.Map the clients never read.
 */
import * as Y from 'yjs'

/** Y.Map field that holds the spreadsheet payload on the shared Y.Doc. */
export const SHEET_YMAP_FIELD = 'sheet'

/**
 * Y.Map field holding column-width / row-height overrides. MUST match
 * octo-web/packages/docs/src/sheet/binding.ts (`SHEET_DIMS_FIELD`):
 *   - field name on the Y.Doc: 'sheetDims'
 *   - key: `c<idx>` (column width) or `r<idx>` (row height), idx a non-negative int
 *   - value: a positive finite number (pixels)
 * This is the sheet's SECOND synced map — it is two-way synced, persisted, and
 * therefore part of the grid that version-restore must reconcile alongside cells.
 */
export const SHEET_DIMS_FIELD = 'sheetDims'

/**
 * Cell shape synced in V1: value, optional formula, and optional resolved style.
 *
 * `s` mirrors the frontend's `SyncCell.s` (binding.ts): the RESOLVED IStyleData
 * object (font / color / size / bg / align), NOT a style id — a bot writing this
 * back must round-trip it verbatim so client-authored styling is preserved.
 * Kept as an opaque object here because the backend never interprets style; it
 * only stores and forwards it on the shared Y.Map.
 */
export interface SheetCell {
  v?: string | number | boolean | null
  f?: string
  s?: Record<string, unknown>
}

/** Build the canonical cell key used by both ends of the binding. */
export function sheetCellKey(sheetId: string, row: number, col: number): string {
  return `${sheetId}!${row}:${col}`
}

/**
 * Raised when a sheet snapshot contains values that violate the `{v,f,s}` cell
 * contract (unexpected keys, wrong value types, non-object entries, hostile keys).
 * Mirrors the ProseMirror path's SchemaIncompatibleError so both the HTTP-return
 * and the live-replay paths can fail-closed instead of serializing / rebroadcasting
 * arbitrary writer-controlled data. Routes map this to 409.
 */
export class SheetSnapshotInvalidError extends Error {
  readonly code = 'sheet_snapshot_invalid'
  constructor(message: string) {
    super(`sheet_snapshot_invalid: ${message}`)
    this.name = 'SheetSnapshotInvalidError'
  }
}

/** Max cell-key length — a canonical `${sheetId}!${row}:${col}` is far shorter. */
const MAX_CELL_KEY_LEN = 256
/** Canonical cell-key shape: `<sheetId>!<row>:<col>` (row/col non-negative ints). */
const CELL_KEY_RE = /^[^!]{1,64}![0-9]{1,7}:[0-9]{1,7}$/

/**
 * Validate a single raw cell key + value against the `{v,f,s}` contract.
 * Fail-closed: throws SheetSnapshotInvalidError on any deviation. Returns a
 * NEW object containing only the contract fields (drops nothing valid, strips
 * nothing — a well-formed cell round-trips byte-for-byte in content).
 *
 * Rules:
 *  - key: canonical `${sheetId}!${row}:${col}` shape, length-bounded.
 *  - value: a plain object; only keys v/f/s permitted.
 *  - v: string | number | boolean | null (if present).
 *  - f: string (if present).
 *  - s: plain object (resolved IStyleData; opaque here) (if present).
 *  - at least one of v/f/s present (no empty cell).
 */
export function validateSheetCell(key: unknown, value: unknown): SheetCell {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_CELL_KEY_LEN) {
    throw new SheetSnapshotInvalidError(`invalid cell key (type/length)`)
  }
  if (!CELL_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(`cell key does not match ${'${sheetId}!${row}:${col}'}: ${key.slice(0, 64)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`cell ${key}: value is not a plain object`)
  }
  const rec = value as Record<string, unknown>
  for (const k of Object.keys(rec)) {
    if (k !== 'v' && k !== 'f' && k !== 's') {
      throw new SheetSnapshotInvalidError(`cell ${key}: unexpected field '${k}'`)
    }
  }
  const out: SheetCell = {}
  if ('v' in rec) {
    const v = rec.v
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new SheetSnapshotInvalidError(`cell ${key}: v has invalid type`)
    }
    out.v = v as SheetCell['v']
  }
  if ('f' in rec) {
    if (typeof rec.f !== 'string') throw new SheetSnapshotInvalidError(`cell ${key}: f is not a string`)
    out.f = rec.f
  }
  if ('s' in rec) {
    const s = rec.s
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: s is not a plain object`)
    }
    out.s = s as Record<string, unknown>
  }
  if (out.v === undefined && out.f === undefined && out.s === undefined) {
    throw new SheetSnapshotInvalidError(`cell ${key}: empty cell (none of v/f/s present)`)
  }
  return out
}

/**
 * Validate + sanitize a whole `{ key: cell }` map, fail-closed. Returns a new
 * map of validated cells. Used on BOTH the HTTP-return path (preview) and the
 * restore-replay path so no writer-controlled value reaches a client or the
 * live doc without passing the contract gate.
 */
export function validateSheetCells(cells: Record<string, unknown>): Record<string, SheetCell> {
  const out: Record<string, SheetCell> = {}
  for (const [key, val] of Object.entries(cells)) out[key] = validateSheetCell(key, val)
  return out
}

/** Canonical dims-key shape: `c<idx>` (col width) or `r<idx>` (row height). */
const DIMS_KEY_RE = /^[cr][0-9]{1,7}$/
/** Max dimension (px) — guards against a hostile/absurd width or height. */
const MAX_DIM_PX = 100000

/**
 * Validate a single raw sheetDims key + value against the dims contract.
 * Fail-closed: throws SheetSnapshotInvalidError on any deviation. Keys are
 * `c<idx>`/`r<idx>`; values must be a positive finite number (pixels).
 */
export function validateSheetDim(key: unknown, value: unknown): number {
  if (typeof key !== 'string' || !DIMS_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(`dims key does not match c<idx>/r<idx>: ${String(key).slice(0, 64)}`)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DIM_PX) {
    throw new SheetSnapshotInvalidError(`dims ${key}: value must be a positive finite number <= ${MAX_DIM_PX}`)
  }
  return value
}

/**
 * Validate + sanitize a whole `{ key: number }` dims map, fail-closed. Returns a
 * new map of validated dimensions. Used on BOTH the HTTP-return path (preview)
 * and the restore-replay path — the dims counterpart of validateSheetCells.
 */
export function validateSheetDims(dims: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, val] of Object.entries(dims)) out[key] = validateSheetDim(key, val)
  return out
}

/**
 * Read: Y.Doc binary state -> plain `{ key: cell }` map (for a bot to understand
 * the current sheet). Keys are the canonical `${sheetId}!${row}:${col}` form.
 */
export function yDocStateToSheetCells(state: Uint8Array): Record<string, SheetCell> {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const ymap = ydoc.getMap<SheetCell>(SHEET_YMAP_FIELD)
  const out: Record<string, SheetCell> = {}
  for (const [key, cell] of ymap.entries()) out[key] = cell
  return out
}

/**
 * The split of a `{ key: cell|null }` edit batch into deletions and validated
 * upserts — the output of the shared, DB-free, live-infra-free validation pass.
 */
export interface SheetCellBatch {
  toDelete: string[]
  toSet: Array<[string, SheetCell]>
}

/**
 * Validate a whole `{ key: cell|null }` edit batch WITHOUT mutating anything,
 * fail-closed. A null value is a deletion (key-shape-checked so a malformed key
 * cannot be smuggled in); any other value is validated against the `{v,f,s}`
 * contract. Throws SheetSnapshotInvalidError on the first deviation.
 *
 * Split out from applySheetCellsToYMap so the HTTP write path can run the exact
 * same contract check in its no-lock pre-flight (fail a bad batch with 422
 * before opening the live write connection) that the live mutation runs — one
 * source of truth for the cell contract, never two subtly different validators.
 */
export function validateSheetCellBatch(cells: Record<string, SheetCell | null>): SheetCellBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, SheetCell]> = []
  for (const [key, cell] of Object.entries(cells)) {
    if (cell == null) {
      // Deletion is always safe; a hostile key simply targets a nonexistent
      // entry. We still key-shape-check so a malformed key can't be smuggled in.
      if (typeof key === 'string' && CELL_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid cell key ${String(key).slice(0, 64)}`)
    } else {
      // Fail-closed: validate the {v,f,s} contract before writing into the doc.
      toSet.push([key, validateSheetCell(key, cell)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction (live doc or transient).
 * A null/undefined cell deletes the key; otherwise it is set. Caller owns the
 * transaction so the whole edit lands as one update (one broadcast).
 */
export function applySheetCellsToYMap(
  ymap: Y.Map<SheetCell>,
  cells: Record<string, SheetCell | null>,
): void {
  // Two-pass, validate-all-then-apply — mirrors reconcileSheetMap's discipline.
  // A mixed batch { valid, invalid } must NOT half-apply: Yjs does not roll back
  // mutations on a thrown transaction callback, and the live caller flushes on
  // disconnect, so a per-iteration set()-then-throw would broadcast a partial
  // write. Validate every entry FIRST; only mutate once the whole batch is known
  // good.
  const { toDelete, toSet } = validateSheetCellBatch(cells)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, cell] of toSet) ymap.set(key, cell)
}
