/**
 * Y.Map <-> whiteboard element/file adapters (backend-only).
 *
 * The frozen `@octo/whiteboard-schema` package is deliberately Yjs-free so the
 * front-end can vendor it verbatim; the conversions that touch Yjs live here.
 * Layout (XIN-16 §1/§2): top-level `Y.Map(ELEMENTS_FIELD)` keyed by element id,
 * each value a per-element `Y.Map<field, value>`; top-level `Y.Map(FILES_FIELD)`
 * keyed by fileId, each value a per-file `Y.Map<field, value>`.
 */
import * as Y from 'yjs'
import { ELEMENTS_FIELD, FILES_FIELD, normalizeFileRef, type FileRef } from './schema/index.js'

export type YElement = Y.Map<unknown>
export type YElements = Y.Map<YElement>

export function getElementsMap(doc: Y.Doc): YElements {
  return doc.getMap(ELEMENTS_FIELD) as YElements
}

export function getFilesMap(doc: Y.Doc): YElements {
  return doc.getMap(FILES_FIELD) as YElements
}

/**
 * Field-value equality good enough for element/file maps (primitives + JSON),
 * NaN-tolerant so a passed-through NaN never forces a spurious rewrite. Mirrors
 * the identical local helper in versionRestore.ts / repair.ts — shared here so
 * the board-scene write path (boardEdit.ts) converges on one definition rather
 * than adding a fourth copy.
 */
export function fieldEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a !== a && b !== b) return true // NaN/NaN (Object.is semantics)
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * Write `obj` field-level into a per-entry Y.Map, making the entry EQUAL `obj`:
 * only changed fields are set and fields absent from `obj` are removed, so a
 * concurrent edit to an unrelated field of another entry survives and the stale
 * removals land as causal tombstones. MUST be called inside a Yjs transaction.
 *
 * This is the same field-level reconcile reconcileEntryMap (versionRestore.ts)
 * and repair's applyPlan already perform per entry; factored out so the live
 * board-scene write reuses one definition. Fields are written in sorted order so
 * struct-creation order stays stable (encoding-significant).
 */
export function writeEntryFields(yEntry: Y.Map<unknown>, obj: Record<string, unknown>): void {
  const cur = readEntry(yEntry)
  for (const f of Object.keys(obj).sort()) {
    if (!fieldEquals(cur[f], obj[f])) yEntry.set(f, obj[f])
  }
  for (const f of Object.keys(cur).sort()) {
    if (!(f in obj)) yEntry.delete(f)
  }
}

/** Read a per-element/-file Y.Map (or a plainly-stored object) into a JS object. */
export function readEntry(value: unknown): Record<string, unknown> {
  if (value instanceof Y.Map) {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of value.entries()) {
      obj[k] = v instanceof Y.AbstractType ? (v as Y.AbstractType<unknown>).toJSON() : v
    }
    return obj
  }
  // Tolerate a corrupt entry stored as a plain object (repair will rewrite it).
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {}
}

/** All element ids currently present (including tombstoned), as a Set. */
export function elementIdSet(doc: Y.Doc): Set<string> {
  return new Set(getElementsMap(doc).keys())
}

/** All fileIds currently present in the files container, as a Set. */
export function fileIdSet(doc: Y.Doc): Set<string> {
  return new Set(getFilesMap(doc).keys())
}

/** Read every element into plain objects keyed by id. */
export function readElements(doc: Y.Doc): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const [id, v] of getElementsMap(doc).entries()) out.set(id, readEntry(v))
  return out
}

/**
 * Read the `files` container into canonical FileRefs keyed by fileId, keeping
 * only entries that carry a usable `attachId` (normalizeFileRef !== null). A
 * fileId whose stored entry has no resolvable binary — the XIN-699
 * grey-placeholder shape — is omitted, so a caller that iterates the result only
 * ever sees references it can actually exchange for a signed GET URL. This is a
 * pure read: it neither mutates the doc nor participates in repair's fileset GC
 * (that GC stays keyed on raw container membership so a split-transaction insert
 * whose ref lands moments later is not dropped).
 */
export function readFileRefs(doc: Y.Doc): Map<string, FileRef> {
  const out = new Map<string, FileRef>()
  for (const [fileId, v] of getFilesMap(doc).entries()) {
    const ref = normalizeFileRef(readEntry(v))
    if (ref) out.set(fileId, ref)
  }
  return out
}
