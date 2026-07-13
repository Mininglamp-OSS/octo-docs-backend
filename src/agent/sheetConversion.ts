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
 *   - cell value: { v?: string|number|boolean|null, f?: string, s?: object,
 *                   p?: object, t?: number }
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
 * Y.Map field for floating images / drawings, keyed `${sheetId}!${drawingId}`
 * (matches octo-web binding.ts SHEET_DRAWINGS_FIELD). Each value is a serialized
 * Univer ISheetImage (opaque here — inline base64 `source`, transform, cell
 * anchor). The bot write surface lets a bot insert/remove a floating image.
 */
export const SHEET_DRAWINGS_FIELD = 'sheetDrawings'

/**
 * Cell shape synced in V1: value, optional formula, optional resolved style, and
 * the two rich-cell fields the live editor also syncs.
 *
 * `s` mirrors the frontend's `SyncCell.s` (binding.ts): the RESOLVED IStyleData
 * object (font / color / size / bg / align), NOT a style id — a bot writing this
 * back must round-trip it verbatim so client-authored styling is preserved.
 * Kept as an opaque object here because the backend never interprets style; it
 * only stores and forwards it on the shared Y.Map.
 *
 * `p` and `t` mirror the frontend's `SyncCell.p` / `SyncCell.t`: `p` is the
 * rich-text document snapshot (Univer stores an INLINE CELL IMAGE as
 * `p.drawings[id].source`), and `t` is the cell type (1 = rich text). Both are
 * part of the live sync schema — the editor writes them and expects them back —
 * so this backend must round-trip them verbatim. They are opaque here (the
 * backend never interprets a cell's rich body or type); dropping either would
 * reload a rich/image cell blank. CLI/bot writers also emit `t`, so accepting it
 * here is what keeps version preview/restore aligned with the live doc.
 */
export interface SheetCell {
  v?: string | number | boolean | null
  f?: string
  s?: Record<string, unknown>
  // Univer also carries `p` (a rich-text cell snapshot — an inline CELL IMAGE
  // rides here as `p.drawings[id].source`) and `t` (cell type; 1 = rich text).
  // The web (Univer) writes these on image / rich cells, so they MUST round-trip
  // through the bot API or a human-edited sheet fails to read (409) / loses its
  // images on a bot write. Treated as opaque (like `s`) — see validateSheetCell.
  p?: Record<string, unknown>
  t?: number
}

/** Build the canonical cell key used by both ends of the binding. */
export function sheetCellKey(sheetId: string, row: number, col: number): string {
  return `${sheetId}!${row}:${col}`
}

/**
 * Raised when a sheet snapshot contains values that violate the
 * `{v,f,s,p,t}` cell contract (unexpected keys, wrong value types, non-object
 * entries, hostile keys). Mirrors the ProseMirror path's SchemaIncompatibleError
 * so both the HTTP-return and the live-replay paths can fail-closed instead of
 * serializing / rebroadcasting arbitrary writer-controlled data. Routes map this
 * to 409.
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
 * Validate a single raw cell key + value against the `{v,f,s,p,t}` contract.
 * Fail-closed: throws SheetSnapshotInvalidError on any deviation. Returns a
 * NEW object containing only the contract fields (drops nothing valid, strips
 * nothing — a well-formed cell round-trips byte-for-byte in content).
 *
 * The field set mirrors the live sync schema (octo-web SyncCell): `v/f/s` plus
 * the rich-cell fields `p` (rich-text/inline-image body) and `t` (cell type)
 * that the editor and CLI/bot writers both emit. All are round-tripped verbatim.
 *
 * Rules:
 *  - key: canonical `${sheetId}!${row}:${col}` shape, length-bounded.
 *  - value: a plain object; only keys v/f/s/p/t permitted.
 *  - v: string | number | boolean | null (if present).
 *  - f: string (if present).
 *  - s: plain object (resolved IStyleData; opaque here) (if present).
 *  - p: plain object (rich-text snapshot; opaque here) (if present).
 *  - t: finite number (cell type; opaque here) (if present).
 *  - at least one of v/f/s/p/t present (no empty cell).
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
    if (k !== 'v' && k !== 'f' && k !== 's' && k !== 'p' && k !== 't') {
      throw new SheetSnapshotInvalidError(`cell ${key}: unexpected field '${k}'`)
    }
  }
  const out: SheetCell = {}
  if ('v' in rec) {
    const v = rec.v
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new SheetSnapshotInvalidError(`cell ${key}: v has invalid type`)
    }
    // A numeric `v` must be finite. Infinity / -Infinity / NaN pass the typeof
    // check but JSON.stringify serializes them to `null`, so they both mis-measure
    // at the size gate (JSON.stringify(Infinity) === 'null') and round-trip through
    // GET as a silent `{"v":null}` — a write-surface data loss. Reject fail-closed,
    // mirroring validateSheetDim's Number.isFinite guard.
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: v must be a finite number`)
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
  // `p` (rich-text snapshot / inline image) is opaque, treated exactly like `s`:
  // a plain object, preserved verbatim so a human-authored image cell round-trips.
  if ('p' in rec) {
    const p = rec.p
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: p is not a plain object`)
    }
    out.p = p as Record<string, unknown>
  }
  if ('t' in rec) {
    const t = rec.t
    // Cell type is a small enum in the live schema; validate it as a finite
    // number (rejecting NaN / Infinity, which JSON.stringify would silently turn
    // into `null`, matching the `v` guard) and round-trip it verbatim.
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new SheetSnapshotInvalidError(`cell ${key}: t must be a finite number`)
    }
    out.t = t
  }
  if (
    out.v === undefined &&
    out.f === undefined &&
    out.s === undefined &&
    out.p === undefined &&
    out.t === undefined
  ) {
    throw new SheetSnapshotInvalidError(`cell ${key}: empty cell (none of v/f/s/p/t present)`)
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
 * cannot be smuggled in); any other value is validated against the `{v,f,s,p,t}`
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
      // Fail-closed: validate the {v,f,s,p,t} contract before writing into the doc.
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

export interface SheetDimBatch {
  toDelete: string[]
  toSet: Array<[string, number]>
}

/**
 * Validate a whole `{ key: number|null }` dims edit batch WITHOUT mutating,
 * fail-closed. A null value is a deletion (key-shape-checked so a malformed key
 * cannot be smuggled in); any other value is validated against the dims contract
 * (`c<idx>`/`r<idx>` key, positive finite px <= MAX_DIM_PX). The dims counterpart
 * of validateSheetCellBatch — one source of truth for the dims contract, shared
 * by the HTTP write path's no-lock pre-flight and the live mutation.
 */
export function validateSheetDimBatch(dims: Record<string, number | null>): SheetDimBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, number]> = []
  for (const [key, val] of Object.entries(dims)) {
    if (val == null) {
      if (typeof key === 'string' && DIMS_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid dims key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetDim(key, val)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction (live doc or transient). A null
 * value deletes the dims key; otherwise it is set. Validate-all-then-apply
 * (mirrors applySheetCellsToYMap) so a mixed { valid, invalid } batch never
 * half-applies.
 */
export function applySheetDimsToYMap(
  ymap: Y.Map<number>,
  dims: Record<string, number | null>,
): void {
  const { toDelete, toSet } = validateSheetDimBatch(dims)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, px] of toSet) ymap.set(key, px)
}

/** A serialized Univer floating image/drawing. Opaque beyond `drawingId` — it
 * carries transform / cell-anchor / inline base64 `source`; we store it verbatim
 * (like a cell's `s`/`p`) so it round-trips to the web binding. */
export interface StoredDrawing {
  drawingId: string
  [k: string]: unknown
}

export interface SheetDrawingBatch {
  toDelete: string[]
  toSet: Array<[string, StoredDrawing]>
}

/** Canonical drawing-key shape: `${sheetId}!${drawingId}` (drawingId alnum/-/_). */
const DRAWING_KEY_RE = /^[^!]{1,64}![A-Za-z0-9_-]{1,64}$/

/**
 * Validate a single raw drawing key + value. Fail-closed. The value is kept
 * opaque (a Univer ISheetImage — transform / source / anchor) EXCEPT `drawingId`,
 * which must be a non-empty string equal to the key's drawingId segment (so a
 * hostile key can't point at a different id). Returns the object verbatim.
 */
export function validateSheetDrawing(key: unknown, value: unknown): StoredDrawing {
  if (typeof key !== 'string' || !DRAWING_KEY_RE.test(key)) {
    throw new SheetSnapshotInvalidError(
      `drawing key does not match ${'${sheetId}!${drawingId}'}: ${String(key).slice(0, 64)}`,
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheetSnapshotInvalidError(`drawing ${key}: value is not a plain object`)
  }
  const rec = value as Record<string, unknown>
  const keyDrawingId = key.slice(key.indexOf('!') + 1)
  if (typeof rec.drawingId !== 'string' || rec.drawingId !== keyDrawingId) {
    throw new SheetSnapshotInvalidError(
      `drawing ${key}: drawingId must be the string "${keyDrawingId}" (key segment)`,
    )
  }
  return rec as StoredDrawing
}

/**
 * Validate a whole `{ key: drawing|null }` batch WITHOUT mutating, fail-closed.
 * null = delete (key-shape-checked); else validated via validateSheetDrawing.
 * The drawings counterpart of validateSheetDimBatch.
 */
export function validateSheetDrawingBatch(
  drawings: Record<string, StoredDrawing | null>,
): SheetDrawingBatch {
  const toDelete: string[] = []
  const toSet: Array<[string, StoredDrawing]> = []
  for (const [key, val] of Object.entries(drawings)) {
    if (val == null) {
      if (typeof key === 'string' && DRAWING_KEY_RE.test(key)) toDelete.push(key)
      else throw new SheetSnapshotInvalidError(`delete: invalid drawing key ${String(key).slice(0, 64)}`)
    } else {
      toSet.push([key, validateSheetDrawing(key, val)])
    }
  }
  return { toDelete, toSet }
}

/**
 * Pure mutation applied INSIDE a Yjs transaction. A null value deletes the
 * drawing; otherwise it is set. Validate-all-then-apply (mirrors the cell/dim
 * appliers) so a mixed batch never half-applies.
 */
export function applySheetDrawingsToYMap(
  ymap: Y.Map<StoredDrawing>,
  drawings: Record<string, StoredDrawing | null>,
): void {
  const { toDelete, toSet } = validateSheetDrawingBatch(drawings)
  for (const key of toDelete) ymap.delete(key)
  for (const [key, d] of toSet) ymap.set(key, d)
}

/**
 * Measure the sheet AFTER applying an edit batch, the two ways its downstream
 * caps are enforced, so the write path can reject an oversized result in its
 * no-lock pre-flight — BEFORE commitLiveSheetEdit applies the cells to the shared
 * live Y.Doc, broadcasts them to peers, and only then fails at persistence.store.
 * The sheet counterpart of docBodyEdit.sizeAfterEdit's 413 gate.
 *
 *   - docBytes: the encoded Y.Doc update length, hydrated from the LIVE
 *     `preEditState` (so it carries the live clientId clocks + tombstones) exactly
 *     as persistence.store caps it at config.maxDocBytes. A from-scratch encode
 *     would be strictly smaller (fresh clientId, no accumulated history) and could
 *     pass this pre-check only to have the live commit broadcast-then-fail on
 *     store — the silent-fork hole this closes.
 *   - payloadBytes: the decoded `{sheetCells, sheetDims}` JSON size, measured the
 *     SAME way GET /:docId/sheet caps it at config.sheetRead.maxCellBytes, so a
 *     batch can never write a sheet that GET then rejects with 413 (a
 *     write-but-not-readable sheet reachable via chained PATCH→PATCH).
 *
 * Pure (no DB, no live infra): the caller compares the returned sizes against the
 * configured caps and maps an overflow to 413.
 */
export function measureSheetAfterEdit(
  preEditState: Uint8Array,
  cells: Record<string, SheetCell | null>,
  dims: Record<string, number | null> = {},
  drawings: Record<string, StoredDrawing | null> = {},
): { docBytes: number; payloadBytes: number } {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, preEditState)
  const ymap = scratch.getMap<SheetCell>(SHEET_YMAP_FIELD)
  const dimsMap = scratch.getMap<number>(SHEET_DIMS_FIELD)
  const drawingMap = scratch.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD)
  // Apply the batch exactly as the live commit will (validate-all-then-apply), so
  // the measured post-edit doc matches what commitLiveSheetEdit would persist.
  scratch.transact(() => {
    applySheetCellsToYMap(ymap, cells)
    applySheetDimsToYMap(dimsMap, dims)
    applySheetDrawingsToYMap(drawingMap, drawings)
  })
  const docBytes = Y.encodeStateAsUpdate(scratch).length
  // Decode + validate the READ maps exactly as GET does (decodeSheetSnapshot /
  // decodeSheetDimsSnapshot) so payloadBytes is byte-identical to the read body.
  // NOTE: drawings are NOT part of the GET payload (their inline base64 would blow
  // the read cap); they only grow docBytes, which the maxDocBytes gate bounds.
  const rawCells: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_YMAP_FIELD).entries()) rawCells[key] = val
  const rawDims: Record<string, unknown> = {}
  for (const [key, val] of scratch.getMap(SHEET_DIMS_FIELD).entries()) rawDims[key] = val
  const sheetCells = validateSheetCells(rawCells)
  const sheetDims = validateSheetDims(rawDims)
  const payloadBytes = Buffer.byteLength(JSON.stringify({ sheetCells, sheetDims }))
  return { docBytes, payloadBytes }
}
