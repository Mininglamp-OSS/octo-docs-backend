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
import { ELEMENTS_FIELD, FILES_FIELD } from './schema/index.js'

export type YElement = Y.Map<unknown>
export type YElements = Y.Map<YElement>

export function getElementsMap(doc: Y.Doc): YElements {
  return doc.getMap(ELEMENTS_FIELD) as YElements
}

export function getFilesMap(doc: Y.Doc): YElements {
  return doc.getMap(FILES_FIELD) as YElements
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
