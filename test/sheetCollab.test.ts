/**
 * Sheet collaboration coverage (§7.x) — the no-DOM Y.Doc <-> cell helpers a bot
 * uses, plus version-restore reconcile for sheets. Complements conversion.test.ts
 * (docs side) and versions.test.ts (restore mechanics for text docs).
 *
 * Focus areas (all previously untested):
 *   - {v,f,s} contract round-trips verbatim (styles must NOT be dropped by a bot).
 *   - applySheetCellsToYMap set + null-delete semantics inside a transaction.
 *   - decodeSheetSnapshot preview extraction.
 *   - reconcileSheetMap: delete-live-only-cell, target-only-cell-added, overwrite,
 *     and the pure-text early-return (no 'sheet' map on either side => false, doc
 *     left byte-identical).
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  SHEET_YMAP_FIELD,
  SHEET_DIMS_FIELD,
  SHEET_DRAWINGS_FIELD,
  sheetCellKey,
  yDocStateToSheetCells,
  applySheetCellsToYMap,
  validateSheetCell,
  validateSheetCells,
  validateSheetDim,
  validateSheetDims,
  validateSheetDrawing,
  validateSheetHyperLink,
  SHEET_HYPERLINKS_FIELD,
  SheetSnapshotInvalidError,
  type SheetCell,
  type StoredDrawing,
  type StoredHyperLink,
} from '../src/agent/sheetConversion.js'
import {
  decodeSheetSnapshot,
  decodeSheetDimsSnapshot,
  decodeSheetHyperLinksSnapshot,
  reconcileSheetMap,
  decodeTargetSnapshot,
  SHEET_YMAP_FIELD as RESTORE_SHEET_FIELD,
  SHEET_DIMS_FIELD as RESTORE_DIMS_FIELD,
  SHEET_DRAWINGS_FIELD as RESTORE_DRAWINGS_FIELD,
  SHEET_HYPERLINKS_FIELD as RESTORE_HYPERLINKS_FIELD,
} from '../src/collab/versionRestore.js'
import { prosemirrorJSONToYDocState } from '../src/agent/conversion.js'
import { advanceEditVersion } from '../src/collab/liveDocWrite.js'
import { reconcileRestoreOntoDoc } from '../src/collab/liveRestore.js'
import { encodeBaseVersion, stateVectorsEqual } from '../src/collab/docBodyEdit.js'

/** Build a Y.Doc binary state whose 'sheet' map holds the given cells. */
function sheetState(cells: Record<string, SheetCell>): Uint8Array {
  const doc = new Y.Doc()
  const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
  doc.transact(() => {
    for (const [k, v] of Object.entries(cells)) ymap.set(k, v)
  })
  return Y.encodeStateAsUpdate(doc)
}

/** Hydrate a live Y.Doc from a sheet state (or empty). */
function liveDocFrom(state?: Uint8Array): Y.Doc {
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, state)
  return doc
}

describe('sheetConversion — cell key + shared field', () => {
  it('SHEET_YMAP_FIELD is the single shared constant across modules', () => {
    expect(SHEET_YMAP_FIELD).toBe('sheet')
    expect(RESTORE_SHEET_FIELD).toBe(SHEET_YMAP_FIELD) // no duplicate re-declaration
  })

  it('sheetCellKey builds the canonical `${sheetId}!${row}:${col}` form', () => {
    expect(sheetCellKey('default', 0, 0)).toBe('default!0:0')
    expect(sheetCellKey('s2', 3, 4)).toBe('s2!3:4')
  })
})

describe('sheetConversion — {v,f,s} contract round-trip (styles must survive)', () => {
  it('preserves value, formula AND resolved style through Y.Doc binary and back', () => {
    const key = sheetCellKey('default', 0, 0)
    const styled: SheetCell = {
      v: 42,
      f: '=B1*2',
      // resolved IStyleData shape the frontend binding syncs (opaque to backend)
      s: { bl: 1, cl: { rgb: '#FF0000' }, bg: { rgb: '#FFFF00' }, ht: 2, vt: 2, fs: 16 },
    }
    const state = sheetState({ [key]: styled })

    const cells = yDocStateToSheetCells(state)
    expect(cells[key]).toEqual(styled)
    // the style object must NOT be dropped or flattened — verbatim round-trip
    expect(cells[key].s).toEqual(styled.s)
  })

  it('round-trips a value-only and a formula-only cell without inventing an `s`', () => {
    const kv = sheetCellKey('default', 1, 0)
    const kf = sheetCellKey('default', 1, 1)
    const state = sheetState({ [kv]: { v: 'text' }, [kf]: { f: '=1+1' } })
    const cells = yDocStateToSheetCells(state)
    expect(cells[kv]).toEqual({ v: 'text' })
    expect(cells[kf]).toEqual({ f: '=1+1' })
    expect(cells[kv].s).toBeUndefined()
  })
})

describe('sheetConversion — applySheetCellsToYMap (set + null-delete)', () => {
  it('sets cells and deletes on null, within a caller transaction', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    const a = sheetCellKey('default', 0, 0)
    const b = sheetCellKey('default', 0, 1)

    doc.transact(() => applySheetCellsToYMap(ymap, { [a]: { v: 1 }, [b]: { v: 2 } }))
    expect(ymap.get(a)).toEqual({ v: 1 })
    expect(ymap.get(b)).toEqual({ v: 2 })

    // null deletes only the targeted key
    doc.transact(() => applySheetCellsToYMap(ymap, { [a]: null }))
    expect(ymap.has(a)).toBe(false)
    expect(ymap.get(b)).toEqual({ v: 2 })
  })
})

describe('versionRestore — decodeSheetSnapshot (preview extraction)', () => {
  it('returns the plain cell map from a snapshot, verbatim (incl. style)', () => {
    const key = sheetCellKey('default', 0, 0)
    const cell: SheetCell = { v: 'H', s: { bl: 1 } }
    const out = decodeSheetSnapshot(sheetState({ [key]: cell }))
    expect(out[key]).toEqual(cell)
  })

  it('returns an empty object for a pure text document (no sheet map)', () => {
    const textState = prosemirrorJSONToYDocState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(decodeSheetSnapshot(textState)).toEqual({})
  })

  it('previews a CLI/bot-authored sheet carrying `t` without throwing (regression: sheet_snapshot_invalid)', () => {
    // Reproduces the shapes from doc d_16324df10007c66051dbf90c version 1241:
    // every cell carries a `t` (cell type) written by s_tmos_bot. Before the
    // schema alignment this threw SheetSnapshotInvalidError -> HTTP 409. Now the
    // preview must succeed AND round-trip `t` (and `f`) verbatim, matching live.
    const cells: Record<string, SheetCell> = {
      [sheetCellKey('default', 0, 0)]: { v: '名称', t: 1 },
      [sheetCellKey('default', 0, 1)]: { v: '数量', t: 1 },
      [sheetCellKey('default', 1, 1)]: { v: 10, t: 2 },
      [sheetCellKey('default', 3, 1)]: { v: 30, f: '=B2+B3', t: 2 },
    }
    const out = decodeSheetSnapshot(sheetState(cells))
    expect(out).toEqual(cells)
  })
})

/**
 * Build a Y.Doc state whose 'sheet' map holds ARBITRARY (possibly contract-
 * violating) values, bypassing any validation. Simulates a hostile/buggy writer
 * that put non-`{v,f,s}` data under the sheet map, so we can prove the read /
 * restore boundaries fail-closed.
 */
function rawSheetState(cells: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc()
  const ymap = doc.getMap(SHEET_YMAP_FIELD)
  doc.transact(() => {
    for (const [k, v] of Object.entries(cells)) ymap.set(k, v as never)
  })
  return Y.encodeStateAsUpdate(doc)
}

describe('sheetConversion — validateSheetCell (fail-closed {v,f,s} boundary)', () => {
  const key = sheetCellKey('default', 0, 0)

  it('accepts a well-formed {v,f,s} cell and returns only contract fields', () => {
    const cell = { v: 1, f: '=A1', s: { bl: 1 } }
    expect(validateSheetCell(key, cell)).toEqual(cell)
  })

  it('accepts each singleton (value-only, formula-only, style-only)', () => {
    expect(validateSheetCell(key, { v: 'x' })).toEqual({ v: 'x' })
    expect(validateSheetCell(key, { f: '=1' })).toEqual({ f: '=1' })
    expect(validateSheetCell(key, { s: { bl: 1 } })).toEqual({ s: { bl: 1 } })
    expect(validateSheetCell(key, { v: null })).toEqual({ v: null })
  })

  it('rejects an unexpected field (not v/f/s/p/t)', () => {
    expect(() => validateSheetCell(key, { v: 1, evil: true })).toThrow(SheetSnapshotInvalidError)
  })

  it('accepts and round-trips the live rich-cell fields p and t', () => {
    // Aligns with octo-web SyncCell: `t` (cell type) + `p` (rich-text/inline-image
    // body) are part of the live sync schema and must round-trip verbatim so a
    // version preview of a bot/CLI-authored sheet no longer fails closed.
    expect(validateSheetCell(key, { v: '名称', t: 1 })).toEqual({ v: '名称', t: 1 })
    expect(validateSheetCell(key, { v: 30, f: '=B2+B3', t: 2 })).toEqual({ v: 30, f: '=B2+B3', t: 2 })
    const p = { drawings: { d1: { source: 'data:image/png;base64,AAAA' } } }
    expect(validateSheetCell(key, { p, t: 1 })).toEqual({ p, t: 1 })
    // A cell carrying only a type still round-trips (mirrors SyncCell, which keeps it).
    expect(validateSheetCell(key, { t: 1 })).toEqual({ t: 1 })
  })

  it('rejects a wrong-typed p / t (p non-object, t non-number or non-finite)', () => {
    expect(() => validateSheetCell(key, { p: 'x' })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { p: [1] })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { t: '1' })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { t: Infinity })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { t: NaN })).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a wrong-typed value (v object / f non-string / s non-object)', () => {
    expect(() => validateSheetCell(key, { v: { nested: 1 } })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { f: 123 })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { s: 'red' })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, { s: [1, 2] })).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a non-object cell entry (string / array / null)', () => {
    expect(() => validateSheetCell(key, 'plain')).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, [1])).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell(key, null)).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects an empty cell (none of v/f/s/p/t present)', () => {
    expect(() => validateSheetCell(key, {})).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a hostile / malformed key', () => {
    expect(() => validateSheetCell('', { v: 1 })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell('no-bang-0:0', { v: 1 })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell('default!x:y', { v: 1 })).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetCell('a'.repeat(300) + '!0:0', { v: 1 })).toThrow(SheetSnapshotInvalidError)
  })

  it('validateSheetCells rejects the whole map if any cell is bad', () => {
    const good = sheetCellKey('default', 0, 0)
    const bad = sheetCellKey('default', 0, 1)
    expect(() => validateSheetCells({ [good]: { v: 1 }, [bad]: { evil: 1 } })).toThrow(
      SheetSnapshotInvalidError,
    )
  })
})

describe('applySheetCellsToYMap — fail-closed on write', () => {
  it('rejects a contract-violating cell before mutating the map', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    const k = sheetCellKey('default', 0, 0)
    expect(() =>
      doc.transact(() => applySheetCellsToYMap(ymap, { [k]: { junk: 1 } as never })),
    ).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a delete with a malformed key', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(() => doc.transact(() => applySheetCellsToYMap(ymap, { 'bad-key': null }))).toThrow(
      SheetSnapshotInvalidError,
    )
  })
})

describe('versionRestore — fail-closed on malformed snapshots (security boundary)', () => {
  const key = sheetCellKey('default', 0, 0)

  it('decodeSheetSnapshot throws instead of serializing arbitrary values into the HTTP response', () => {
    const state = rawSheetState({ [key]: { v: 1, evil: 'payload' } })
    expect(() => decodeSheetSnapshot(state)).toThrow(SheetSnapshotInvalidError)
  })

  it('decodeSheetSnapshot throws on a non-cell entry (string smuggled under the sheet map)', () => {
    const state = rawSheetState({ [key]: 'not-a-cell' })
    expect(() => decodeSheetSnapshot(state)).toThrow(SheetSnapshotInvalidError)
  })

  it('reconcileSheetMap throws and leaves the live doc untouched when the target is malformed', () => {
    const liveKey = sheetCellKey('default', 5, 5)
    const live = liveDocFrom(sheetState({ [liveKey]: { v: 'safe' } }))
    const before = Y.encodeStateAsUpdate(live)
    const badTarget = rawSheetState({ [key]: { v: 1, hostile: true } })

    expect(() => live.transact(() => reconcileSheetMap(live, badTarget))).toThrow(
      SheetSnapshotInvalidError,
    )
    // The live-only cell must NOT have been deleted — validation runs before any mutation.
    const after = Y.encodeStateAsUpdate(live)
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(liveKey)).toEqual({ v: 'safe' })
    expect(Array.from(after)).toEqual(Array.from(before)) // byte-identical, no partial restore
  })
})

describe('versionRestore — reconcileSheetMap', () => {
  it('deletes a live-only cell not present in the target', () => {
    const keep = sheetCellKey('default', 0, 0)
    const liveOnly = sheetCellKey('default', 0, 1)
    const live = liveDocFrom(sheetState({ [keep]: { v: 'keep' }, [liveOnly]: { v: 'gone' } }))
    const target = sheetState({ [keep]: { v: 'keep' } })

    let touched = false
    live.transact(() => {
      touched = reconcileSheetMap(live, target)
    })
    const sheet = live.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(touched).toBe(true)
    expect(sheet.has(liveOnly)).toBe(false) // live-only deleted
    expect(sheet.get(keep)).toEqual({ v: 'keep' })
  })

  it('adds a target-only cell absent from the live doc', () => {
    const existing = sheetCellKey('default', 0, 0)
    const added = sheetCellKey('default', 2, 2)
    const live = liveDocFrom(sheetState({ [existing]: { v: 'a' } }))
    const target = sheetState({ [existing]: { v: 'a' }, [added]: { v: 'new', s: { bl: 1 } } })

    live.transact(() => reconcileSheetMap(live, target))
    const sheet = live.getMap<SheetCell>(SHEET_YMAP_FIELD)
    expect(sheet.get(added)).toEqual({ v: 'new', s: { bl: 1 } }) // added incl. style
  })

  it('overwrites a cell whose value/style changed in the target', () => {
    const k = sheetCellKey('default', 0, 0)
    const live = liveDocFrom(sheetState({ [k]: { v: 'old', s: { bl: 0 } } }))
    const target = sheetState({ [k]: { v: 'new', s: { bl: 1 } } })
    live.transact(() => reconcileSheetMap(live, target))
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(k)).toEqual({ v: 'new', s: { bl: 1 } })
  })

  it('is a no-op for a pure text document (early-return false, bytes unchanged)', () => {
    const textState = prosemirrorJSONToYDocState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    })
    const live = liveDocFrom(textState)
    const before = Y.encodeStateAsUpdate(live)

    let touched = true
    live.transact(() => {
      touched = reconcileSheetMap(live, textState)
    })
    const after = Y.encodeStateAsUpdate(live)

    expect(touched).toBe(false) // neither side has a 'sheet' map
    expect(Array.from(after)).toEqual(Array.from(before)) // byte-identical
  })
})

describe('liveRestore — reconcileRestoreOntoDoc advances the base version (P1-a)', () => {
  const keep = sheetCellKey('default', 0, 0)
  const drop = sheetCellKey('default', 0, 1)

  it('a delete-only sheet restore moves the state vector forward', () => {
    // Seed a live doc from a two-cell sheet, then reconcile it (once) to a
    // one-cell target so its fragment already holds the canonical empty doc — the
    // SECOND reconcile below then changes only the sheet (a pure deletion), which
    // is where the SV-reuse hazard lives.
    const live = liveDocFrom(sheetState({ [keep]: { v: 'a' }, [drop]: { v: 'b' } }))
    const oneCell = sheetState({ [keep]: { v: 'a' } })
    live.transact(() => reconcileRestoreOntoDoc(live, decodeTargetSnapshot(oneCell), oneCell))

    // Delete-only restore: target has NO cells, so reconcileSheetMap only issues
    // deletes and the fragment reconcile is a no-op (already the empty doc).
    const emptySheet = sheetState({})
    const svBefore = Y.encodeStateVector(live)
    live.transact(() => reconcileRestoreOntoDoc(live, decodeTargetSnapshot(emptySheet), emptySheet))

    // The cell was deleted AND the base version advanced despite no insert.
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).size).toBe(0)
    expect(stateVectorsEqual(svBefore, Y.encodeStateVector(live))).toBe(false)
  })

  it('the hazard is real: reconcileSheetMap alone leaves a delete-only SV byte-identical', () => {
    // The "why" for the bump above — a pure delete records only tombstones, and
    // Y.encodeStateVector tracks insert clocks, so without advanceEditVersion the
    // token would be reusable across a delete-only restore.
    const live = liveDocFrom(sheetState({ [keep]: { v: 'a' } }))
    const svBefore = Y.encodeStateVector(live)
    live.transact(() => reconcileSheetMap(live, sheetState({})))
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).size).toBe(0) // deletion happened
    expect(stateVectorsEqual(svBefore, Y.encodeStateVector(live))).toBe(true) // yet SV unchanged
  })
})

/** Build a Y.Doc binary state whose 'sheetDims' map holds the given dims. */
function dimsState(dims: Record<string, number>, cells: Record<string, SheetCell> = {}): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    const cellMap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    for (const [k, v] of Object.entries(cells)) cellMap.set(k, v)
    const dimMap = doc.getMap<number>(SHEET_DIMS_FIELD)
    for (const [k, v] of Object.entries(dims)) dimMap.set(k, v)
  })
  return Y.encodeStateAsUpdate(doc)
}

/** Build a Y.Doc binary state with an arbitrary (possibly hostile) sheetDims map. */
function rawDimsState(dims: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc()
  const dimMap = doc.getMap(SHEET_DIMS_FIELD)
  doc.transact(() => {
    for (const [k, v] of Object.entries(dims)) dimMap.set(k, v as never)
  })
  return Y.encodeStateAsUpdate(doc)
}

describe('sheetConversion — validateSheetDim (fail-closed c<idx>/r<idx> contract)', () => {
  it('accepts a positive finite width/height with a valid key', () => {
    expect(validateSheetDim('c0', 120)).toBe(120)
    expect(validateSheetDim('r3', 42)).toBe(42)
  })

  it('rejects a bad key shape', () => {
    expect(() => validateSheetDim('x0', 100)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDim('c', 100)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDim('col1', 100)).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects non-positive, non-finite, or absurd values', () => {
    expect(() => validateSheetDim('c0', 0)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDim('c0', -5)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDim('c0', Infinity)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDim('c0', 1e9)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDim('c0', '120' as never)).toThrow(SheetSnapshotInvalidError)
  })

  it('validateSheetDims rejects the whole batch if any entry is bad', () => {
    expect(() => validateSheetDims({ c0: 100, r1: -1 })).toThrow(SheetSnapshotInvalidError)
    expect(validateSheetDims({ c0: 100, r1: 30 })).toEqual({ c0: 100, r1: 30 })
  })
})

describe('versionRestore — sheetDims decode + restore (P1: full-grid restore)', () => {
  it('SHEET_DIMS_FIELD is the single shared constant across modules', () => {
    expect(SHEET_DIMS_FIELD).toBe('sheetDims')
    expect(RESTORE_DIMS_FIELD).toBe(SHEET_DIMS_FIELD)
  })

  it('decodeSheetDimsSnapshot extracts col-width/row-height overrides for preview', () => {
    const state = dimsState({ c0: 200, r2: 48 })
    expect(decodeSheetDimsSnapshot(state)).toEqual({ c0: 200, r2: 48 })
  })

  it('decodeSheetDimsSnapshot returns {} for a text document (no sheetDims map)', () => {
    const textState = prosemirrorJSONToYDocState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    })
    expect(decodeSheetDimsSnapshot(textState)).toEqual({})
  })

  it('decodeSheetDimsSnapshot throws (fail-closed) on a hostile dims value', () => {
    const state = rawDimsState({ c0: -999 })
    expect(() => decodeSheetDimsSnapshot(state)).toThrow(SheetSnapshotInvalidError)
  })

  it('reconcileSheetMap restores dims alongside cells (widen-then-restore rolls back layout)', () => {
    // Target snapshot: narrow col c0=80, plus a cell.
    const k = sheetCellKey('default', 0, 0)
    const target = dimsState({ c0: 80 }, { [k]: { v: 'old' } })
    // Live doc: user widened c0 to 300 and added a stray dim r5.
    const live = liveDocFrom(dimsState({ c0: 300, r5: 60 }, { [k]: { v: 'new' } }))

    live.transact(() => reconcileSheetMap(live, target))

    const dims = live.getMap<number>(SHEET_DIMS_FIELD)
    expect(dims.get('c0')).toBe(80) // rolled back to target width
    expect(dims.has('r5')).toBe(false) // live-only dim removed
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(k)).toEqual({ v: 'old' })
  })

  it('reconcileSheetMap fires (returns true) when only dims differ, cells empty', () => {
    const target = dimsState({ c1: 150 })
    const live = liveDocFrom(dimsState({ c1: 90 }))
    let touched = false
    live.transact(() => {
      touched = reconcileSheetMap(live, target)
    })
    expect(touched).toBe(true)
    expect(live.getMap<number>(SHEET_DIMS_FIELD).get('c1')).toBe(150)
  })

  it('reconcileSheetMap throws + leaves BOTH maps untouched on a malformed target dim', () => {
    const k = sheetCellKey('default', 0, 0)
    const live = liveDocFrom(dimsState({ c0: 120 }, { [k]: { v: 'safe' } }))
    const badTarget = rawDimsState({ c0: -1 }) // hostile dim
    expect(() => live.transact(() => reconcileSheetMap(live, badTarget))).toThrow(
      SheetSnapshotInvalidError,
    )
    // fail-closed: live dims + cells unchanged (no half-restore)
    expect(live.getMap<number>(SHEET_DIMS_FIELD).get('c0')).toBe(120)
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(k)).toEqual({ v: 'safe' })
  })
})

/** A minimal well-formed drawing whose drawingId matches what the key will carry. */
function drawing(id: string, source = 'data:image/png;base64,AAAA'): StoredDrawing {
  return { drawingId: id, drawingType: 0, imageSourceType: 'BASE64', source }
}

/** Build a Y.Doc state carrying sheetDrawings (+ optional cells/dims). */
function drawingsState(
  drawings: Record<string, StoredDrawing>,
  cells: Record<string, SheetCell> = {},
  dims: Record<string, number> = {},
): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    const cellMap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    for (const [k, v] of Object.entries(cells)) cellMap.set(k, v)
    const dimMap = doc.getMap<number>(SHEET_DIMS_FIELD)
    for (const [k, v] of Object.entries(dims)) dimMap.set(k, v)
    const drawMap = doc.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD)
    for (const [k, v] of Object.entries(drawings)) drawMap.set(k, v)
  })
  return Y.encodeStateAsUpdate(doc)
}

describe('sheetConversion — validateSheetDrawing (fail-closed key + drawingId contract)', () => {
  it('accepts a well-formed drawing whose drawingId equals the key segment', () => {
    const d = drawing('img1')
    expect(validateSheetDrawing('default!img1', d)).toBe(d)
  })

  it('rejects a bad key shape (no sheetId! prefix, or colon in drawingId)', () => {
    expect(() => validateSheetDrawing('img1', drawing('img1'))).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDrawing('default!0:0', drawing('0:0'))).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a drawingId that does not match the key segment (anti-spoof)', () => {
    expect(() => validateSheetDrawing('default!img1', drawing('OTHER'))).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a non-object / null / missing-drawingId value', () => {
    expect(() => validateSheetDrawing('default!img1', null)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDrawing('default!img1', [] as never)).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetDrawing('default!img1', { drawingType: 0 } as never)).toThrow(
      SheetSnapshotInvalidError,
    )
  })
})

describe('versionRestore — sheetDrawings restore (floating images roll back with the grid)', () => {
  it('SHEET_DRAWINGS_FIELD is the single shared constant across modules', () => {
    expect(SHEET_DRAWINGS_FIELD).toBe('sheetDrawings')
    expect(RESTORE_DRAWINGS_FIELD).toBe(SHEET_DRAWINGS_FIELD)
  })

  it('reconcileSheetMap restores drawings alongside cells (insert-then-restore removes the live-only image, rolls back the changed one)', () => {
    const k = sheetCellKey('default', 0, 0)
    const target = drawingsState(
      { 'default!img1': drawing('img1', 'data:image/png;base64,OLD') },
      { [k]: { v: 'old' } },
    )
    // Live: user changed img1's source AND added a stray image img2.
    const live = liveDocFrom(
      drawingsState(
        {
          'default!img1': drawing('img1', 'data:image/png;base64,NEW'),
          'default!img2': drawing('img2'),
        },
        { [k]: { v: 'new' } },
      ),
    )

    live.transact(() => reconcileSheetMap(live, target))

    const draw = live.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD)
    expect(draw.has('default!img2')).toBe(false) // live-only image removed
    expect((draw.get('default!img1') as StoredDrawing).source).toBe('data:image/png;base64,OLD') // rolled back
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(k)).toEqual({ v: 'old' })
  })

  it('reconcileSheetMap fires (returns true) when only drawings differ, cells+dims empty', () => {
    const target = drawingsState({ 'default!img1': drawing('img1') })
    const live = liveDocFrom() // empty doc
    let touched = false
    live.transact(() => {
      touched = reconcileSheetMap(live, target)
    })
    expect(touched).toBe(true)
    expect(live.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).has('default!img1')).toBe(true)
  })

  it('reconcileSheetMap throws + leaves maps untouched on a malformed target drawing', () => {
    const k = sheetCellKey('default', 0, 0)
    const live = liveDocFrom(drawingsState({ 'default!keep': drawing('keep') }, { [k]: { v: 'safe' } }))
    // Hostile target: drawingId mismatches the key segment.
    const badTarget = (() => {
      const doc = new Y.Doc()
      doc.getMap(SHEET_DRAWINGS_FIELD).set('default!img1', { drawingId: 'WRONG' } as never)
      return Y.encodeStateAsUpdate(doc)
    })()
    expect(() => live.transact(() => reconcileSheetMap(live, badTarget))).toThrow(SheetSnapshotInvalidError)
    // fail-closed: live drawings + cells unchanged (no half-restore)
    expect(live.getMap<StoredDrawing>(SHEET_DRAWINGS_FIELD).has('default!keep')).toBe(true)
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(k)).toEqual({ v: 'safe' })
  })
})

/** A well-formed hyperlink whose id matches what the key will carry. */
function hyperlink(id: string, payload = 'https://example.com'): StoredHyperLink {
  return { id, row: 1, column: 2, payload, display: 'link' }
}

/** Build a Y.Doc state carrying sheetHyperLinks (+ optional cells). */
function hyperlinksState(
  links: Record<string, StoredHyperLink>,
  cells: Record<string, SheetCell> = {},
): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    const cellMap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    for (const [k, v] of Object.entries(cells)) cellMap.set(k, v)
    const linkMap = doc.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
    for (const [k, v] of Object.entries(links)) linkMap.set(k, v)
  })
  return Y.encodeStateAsUpdate(doc)
}

describe('sheetConversion — validateSheetHyperLink (fail-closed key + id + payload contract)', () => {
  it('accepts a well-formed hyperlink whose id equals the key segment', () => {
    const h = hyperlink('lnk1')
    expect(validateSheetHyperLink('default!lnk1', h)).toBe(h)
  })

  it('accepts http/https/mailto and an internal #jump payload', () => {
    expect(validateSheetHyperLink('default!a', { id: 'a', row: 0, column: 0, payload: 'http://x.io' })).toBeTruthy()
    expect(validateSheetHyperLink('default!b', { id: 'b', row: 0, column: 0, payload: 'mailto:x@y.io' })).toBeTruthy()
    expect(validateSheetHyperLink('default!c', { id: 'c', row: 0, column: 0, payload: '#gid=s1&range=A1' })).toBeTruthy()
  })

  it('rejects a bad key shape (no sheetId! prefix, or colon in linkId)', () => {
    expect(() => validateSheetHyperLink('lnk1', hyperlink('lnk1'))).toThrow(SheetSnapshotInvalidError)
    expect(() => validateSheetHyperLink('default!0:0', hyperlink('0:0'))).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects an id that does not match the key segment (anti-spoof)', () => {
    expect(() => validateSheetHyperLink('default!lnk1', hyperlink('OTHER'))).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects an unsafe payload scheme (javascript:/data:) — stored-XSS guard', () => {
    expect(() =>
      validateSheetHyperLink('default!x', { id: 'x', row: 0, column: 0, payload: 'javascript:alert(1)' }),
    ).toThrow(SheetSnapshotInvalidError)
    expect(() =>
      validateSheetHyperLink('default!x', { id: 'x', row: 0, column: 0, payload: 'data:text/html,x' }),
    ).toThrow(SheetSnapshotInvalidError)
  })

  it('rejects a negative / non-integer row or column, and a non-string payload', () => {
    expect(() =>
      validateSheetHyperLink('default!x', { id: 'x', row: -1, column: 0, payload: 'https://x.io' }),
    ).toThrow(SheetSnapshotInvalidError)
    expect(() =>
      validateSheetHyperLink('default!x', { id: 'x', row: 1.5, column: 0, payload: 'https://x.io' }),
    ).toThrow(SheetSnapshotInvalidError)
    expect(() =>
      validateSheetHyperLink('default!x', { id: 'x', row: 0, column: 0, payload: 123 as never }),
    ).toThrow(SheetSnapshotInvalidError)
  })
})

describe('versionRestore — sheetHyperLinks restore + decode', () => {
  it('SHEET_HYPERLINKS_FIELD is the single shared constant across modules', () => {
    expect(SHEET_HYPERLINKS_FIELD).toBe('sheetHyperLinks')
    expect(RESTORE_HYPERLINKS_FIELD).toBe(SHEET_HYPERLINKS_FIELD)
  })

  it('decodeSheetHyperLinksSnapshot extracts + validates the links', () => {
    const state = hyperlinksState({ 'default!lnk1': hyperlink('lnk1') })
    expect(decodeSheetHyperLinksSnapshot(state)).toEqual({ 'default!lnk1': hyperlink('lnk1') })
  })

  it('reconcileSheetMap restores hyperlinks alongside cells (removes live-only link, rolls back changed one)', () => {
    const k = sheetCellKey('default', 0, 0)
    const target = hyperlinksState(
      { 'default!lnk1': { id: 'lnk1', row: 1, column: 2, payload: 'https://old.io' } },
      { [k]: { v: 'old' } },
    )
    const live = liveDocFrom(
      hyperlinksState(
        {
          'default!lnk1': { id: 'lnk1', row: 1, column: 2, payload: 'https://new.io' },
          'default!lnk2': { id: 'lnk2', row: 3, column: 4, payload: 'https://stray.io' },
        },
        { [k]: { v: 'new' } },
      ),
    )
    live.transact(() => reconcileSheetMap(live, target))
    const links = live.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD)
    expect(links.has('default!lnk2')).toBe(false) // live-only link removed
    expect((links.get('default!lnk1') as StoredHyperLink).payload).toBe('https://old.io') // rolled back
    expect(live.getMap<SheetCell>(SHEET_YMAP_FIELD).get(k)).toEqual({ v: 'old' })
  })

  it('reconcileSheetMap fires (returns true) when only hyperlinks differ, cells+dims empty', () => {
    const target = hyperlinksState({ 'default!lnk1': hyperlink('lnk1') })
    const live = liveDocFrom()
    let touched = false
    live.transact(() => {
      touched = reconcileSheetMap(live, target)
    })
    expect(touched).toBe(true)
    expect(live.getMap<StoredHyperLink>(SHEET_HYPERLINKS_FIELD).has('default!lnk1')).toBe(true)
  })
})

describe('applySheetCellsToYMap — P2: validate-all-then-apply atomicity', () => {
  it('a mixed batch with one invalid cell writes NOTHING (no partial flush)', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    const good = sheetCellKey('default', 0, 0)
    const bad = sheetCellKey('default', 1, 0)
    expect(() =>
      doc.transact(() =>
        applySheetCellsToYMap(ymap, { [good]: { v: 'ok' }, [bad]: { junk: 1 } as never }),
      ),
    ).toThrow(SheetSnapshotInvalidError)
    // The valid cell must NOT have been set before the invalid one threw.
    expect(ymap.has(good)).toBe(false)
    expect(ymap.size).toBe(0)
  })

  it('a bad delete key also aborts before any valid set lands', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    const good = sheetCellKey('default', 0, 0)
    expect(() =>
      doc.transact(() => applySheetCellsToYMap(ymap, { [good]: { v: 'ok' }, 'bad-key': null })),
    ).toThrow(SheetSnapshotInvalidError)
    expect(ymap.has(good)).toBe(false)
  })

  it('an all-valid mixed set+delete batch applies fully', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
    const a = sheetCellKey('default', 0, 0)
    const b = sheetCellKey('default', 1, 0)
    doc.transact(() => applySheetCellsToYMap(ymap, { [a]: { v: 1 }, [b]: { v: 2 } }))
    doc.transact(() => applySheetCellsToYMap(ymap, { [a]: null, [b]: { v: 3 } }))
    expect(ymap.has(a)).toBe(false)
    expect(ymap.get(b)).toEqual({ v: 3 })
  })
})

/**
 * commitLiveSheetEdit's Y.Doc core, exercised for real (XIN-664).
 *
 * The docSheetWrite unit test mocks commitLiveSheetEdit, so the ACTUAL mutation
 * that runs on the shared live Y.Doc — applySheetCellsToYMap + advanceEditVersion,
 * then re-encoding the state vector — was never covered end to end. The tester's
 * real-machine run (XIN-661) hit the live path and exposed that only the mocked
 * behavior had been asserted. This replays the exact transact body of
 * commitLiveSheetEdit on a real Y.Doc (no hocuspocus/DB needed — the direct
 * connection just hands the callback a doc) and asserts the three properties the
 * write endpoint promises: {v,f,s} round-trips, {key:null} deletes, and the
 * baseVersion token advances on BOTH a set and a delete-only edit.
 */
describe('commitLiveSheetEdit core — real Y.Doc write/delete round-trip + baseVersion advance', () => {
  const key = sheetCellKey('default', 0, 0)

  /** Mirror of commitLiveSheetEdit's transact body: guard, apply, bump, re-read. */
  function commit(doc: Y.Doc, clientBaseVersion: Uint8Array, cells: Record<string, SheetCell | null>) {
    let newSV!: Uint8Array
    doc.transact(() => {
      // (1) optimistic-concurrency guard — must match the caller's read.
      if (!stateVectorsEqual(clientBaseVersion, Y.encodeStateVector(doc))) {
        throw new Error('base_version_stale')
      }
      // (2) the single content mutation on the live 'sheet' map.
      applySheetCellsToYMap(doc.getMap<SheetCell>(SHEET_YMAP_FIELD), cells)
      // (3) advance the edit-version counter so a delete-only batch also moves SV.
      advanceEditVersion(doc)
      newSV = Y.encodeStateVector(doc)
    })
    return newSV
  }

  it('writes a {v,f,s} cell that reads back verbatim and advances the base version', () => {
    const doc = new Y.Doc()
    const sv0 = Y.encodeStateVector(doc)

    const cell: SheetCell = { v: 'hello', f: '=A1*2', s: { bl: 1, cl: { rgb: '#FF0000' } } }
    const sv1 = commit(doc, sv0, { [key]: cell })

    // round-trips verbatim through the live map (style not dropped/flattened).
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).get(key)).toEqual(cell)
    expect(yDocStateToSheetCells(Y.encodeStateAsUpdate(doc))[key]).toEqual(cell)
    // baseVersion token advanced, so the old token can no longer pass the guard.
    expect(stateVectorsEqual(sv0, sv1)).toBe(false)
    expect(encodeBaseVersion(sv1)).not.toBe(encodeBaseVersion(sv0))
  })

  it('deletes a cell with {key:null}, leaving it absent, and still advances the base version', () => {
    const doc = new Y.Doc()
    // seed a cell to delete, capturing the post-seed token the client would hold.
    const svSeed = commit(doc, Y.encodeStateVector(doc), { [key]: { v: 'gone' } })
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).has(key)).toBe(true)

    // delete-only batch: Y.Map.delete records only a tombstone, so without
    // advanceEditVersion the SV would be byte-identical — assert it advances.
    const svDel = commit(doc, svSeed, { [key]: null })
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).has(key)).toBe(false)
    expect(stateVectorsEqual(svSeed, svDel)).toBe(false)
  })

  it('a stale base version fails the guard before any mutation (no write, no SV move)', () => {
    const doc = new Y.Doc()
    const sv0 = Y.encodeStateVector(doc)
    // advance the doc so sv0 is now stale.
    commit(doc, sv0, { [key]: { v: 1 } })
    const svCurrent = Y.encodeStateVector(doc)

    const other = sheetCellKey('default', 1, 1)
    expect(() => commit(doc, sv0, { [other]: { v: 2 } })).toThrow('base_version_stale')
    // the rejected edit left nothing behind.
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).has(other)).toBe(false)
    expect(stateVectorsEqual(svCurrent, Y.encodeStateVector(doc))).toBe(true)
  })

  it('the tester\'s A1-notation key is rejected, the contract key `default!0:0` is accepted', () => {
    // Root cause of the XIN-661 TC3/TC5 422s: an A1-notation key ("A1") violates
    // the cross-repo `${sheetId}!${row}:${col}` contract, so validation fails
    // before any write. The canonical key round-trips through the same commit.
    const doc = new Y.Doc()
    const sv0 = Y.encodeStateVector(doc)
    expect(() => commit(doc, sv0, { A1: { v: 'hello' } as SheetCell })).toThrow(
      SheetSnapshotInvalidError,
    )
    // no partial write from the rejected batch.
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).size).toBe(0)

    const sv1 = commit(doc, sv0, { [key]: { v: 'hello' } })
    expect(doc.getMap<SheetCell>(SHEET_YMAP_FIELD).get(key)).toEqual({ v: 'hello' })
    expect(stateVectorsEqual(sv0, sv1)).toBe(false)
  })
})
