/**
 * XIN-794 — migration detection + re-repair (pure, DB-free).
 * See src/whiteboard/migrateFractionalIndex.ts. The CLI wrapper
 * (scripts/repairFractionalIndices.ts) supplies MySQL around these functions.
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  LEGACY_ILLEGAL_INDEX_RE,
  isLegacyIllegalIndex,
  findLegacyIllegalIndices,
  stateHasLegacyIllegalIndex,
  migrateState,
} from '../src/whiteboard/migrateFractionalIndex.js'
import { readElements } from '../src/whiteboard/ydoc.js'
import { isValidIndex } from '../src/whiteboard/schema/index.js'
import { ELEMENTS_FIELD } from '../src/whiteboard/schema/index.js'

function encodeDoc(elements: Record<string, Record<string, unknown>>): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    const el = doc.getMap(ELEMENTS_FIELD)
    for (const [id, obj] of Object.entries(elements)) {
      const m = new Y.Map()
      for (const [k, v] of Object.entries(obj)) m.set(k, v)
      el.set(id, m as Y.Map<unknown>)
    }
  })
  const out = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return out
}

describe('XIN-794 migration — legacy illegal index detection', () => {
  it('matches only the r+8-base36 synthetic shape', () => {
    expect(LEGACY_ILLEGAL_INDEX_RE.test('r00000003')).toBe(true)
    expect(isLegacyIllegalIndex('r00000000')).toBe(true)
    expect(isLegacyIllegalIndex('rzzzzzzzz')).toBe(true)
    expect(isLegacyIllegalIndex('a0')).toBe(false) // legit key
    expect(isLegacyIllegalIndex('r0000000')).toBe(false) // only 7 digits
    expect(isLegacyIllegalIndex('r000000000')).toBe(false) // 9 digits
    expect(isLegacyIllegalIndex('R00000003')).toBe(false) // uppercase head
    expect(isLegacyIllegalIndex(42)).toBe(false)
  })

  it('finds victim element ids in a persisted state (sorted)', () => {
    const state = encodeDoc({
      good: { id: 'good', type: 'rectangle', version: 1, versionNonce: 1, index: 'a0' },
      bad2: { id: 'bad2', type: 'rectangle', version: 1, versionNonce: 1, index: 'r00000005' },
      bad1: { id: 'bad1', type: 'rectangle', version: 1, versionNonce: 1, index: 'r00000003' },
    })
    expect(findLegacyIllegalIndices(state)).toEqual(['bad1', 'bad2'])
    expect(stateHasLegacyIllegalIndex(state)).toBe(true)
  })

  it('reports no victims for a clean state and tolerates null/empty', () => {
    const clean = encodeDoc({
      a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1, index: 'a0' },
    })
    expect(findLegacyIllegalIndices(clean)).toEqual([])
    expect(stateHasLegacyIllegalIndex(clean)).toBe(false)
    expect(findLegacyIllegalIndices(null)).toEqual([])
    expect(findLegacyIllegalIndices(new Uint8Array())).toEqual([])
  })
})

describe('XIN-794 migration — migrateState re-repairs to legal keys', () => {
  it('rewrites a victim doc so every index is legal, and is idempotent', () => {
    const state = encodeDoc({
      a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1, index: 'r00000003' },
      b: { id: 'b', type: 'rectangle', version: 1, versionNonce: 1, index: 'a0' },
    })
    const first = migrateState(state)
    expect(first.changed).toBe(true)

    const doc = new Y.Doc()
    Y.applyUpdate(doc, first.state)
    for (const el of readElements(doc).values()) {
      expect(isValidIndex(el.index)).toBe(true)
    }
    doc.destroy()

    // no victim remains, and re-running the migration changes nothing.
    expect(findLegacyIllegalIndices(first.state)).toEqual([])
    const second = migrateState(first.state)
    expect(second.changed).toBe(false)
    expect(Buffer.from(second.state)).toEqual(Buffer.from(first.state))
  })

  it('leaves an already-clean doc byte-identical (changed=false)', () => {
    const clean = encodeDoc({
      a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1, index: 'a0' },
    })
    const res = migrateState(clean)
    expect(res.changed).toBe(false)
  })
})
