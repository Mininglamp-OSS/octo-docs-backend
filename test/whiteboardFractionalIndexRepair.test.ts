/**
 * XIN-794 — fillIndexKey must produce a STRUCTURALLY LEGAL fractional-index key,
 * and normalize must REJECT the illegal `r`+base36 shape the pre-fix repair
 * emitted (e.g. `r00000003`).
 *
 * Root cause (XIN-786/792): the old `fillIndexKey(seq)` returned
 * `r${seq.toString(36).padStart(8,'0')}` — a 9-char string whose head 'r'
 * demands a 19-char integer part under Excalidraw's `fractional-indexing`
 * (jitterbug) alphabet, so it is structurally invalid. The old
 * `INDEX_RE=/^[A-Za-z0-9]+$/` only checked the charset, so `isValidIndex` let it
 * through. A victim doc broadcast its illegal key to the FE binding, which threw
 * in updateScene and crashed the render.
 *
 * These tests assert the POST-FIX behaviour, so they are RED against the current
 * (pre-fix) code:
 *   - `isValidIndex('r00000003')` is `true` today  -> must become `false`.
 *   - repair fills an indexless element with `r00000000` today -> must become a
 *     key that `fractional-indexing` accepts.
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { generateKeyBetween } from 'fractional-indexing'
import { repairLiveDoc } from '../src/whiteboard/repair.js'
import { readElements } from '../src/whiteboard/ydoc.js'
import { isValidIndex, normalizeElement } from '../src/whiteboard/schema/index.js'
import { ELEMENTS_FIELD } from '../src/whiteboard/schema/index.js'

/** The exact illegal synthetic key the pre-fix `fillIndexKey` produced first. */
const LEGACY_ILLEGAL = 'r00000003'
/** Shape of every legacy synthetic key: `r` + 8 base36 chars. */
const LEGACY_ILLEGAL_SHAPE = /^r[0-9a-z]{8}$/

/** A key is a valid jitterbug order key iff `fractional-indexing` accepts it as
 *  a generation bound (v4 does not export validateOrderKey). */
function acceptedByFractionalIndexing(key: string): boolean {
  try {
    generateKeyBetween(key, null)
    return true
  } catch {
    return false
  }
}

function buildDoc(elements: Record<string, Record<string, unknown>>): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const el = doc.getMap(ELEMENTS_FIELD)
    for (const [id, obj] of Object.entries(elements)) {
      const m = new Y.Map()
      for (const [k, v] of Object.entries(obj)) m.set(k, v)
      el.set(id, m as Y.Map<unknown>)
    }
  }, 'seed')
  return doc
}

describe('XIN-794 — isValidIndex structural jitterbug check', () => {
  it('rejects the structurally-illegal legacy synthetic key r00000003', () => {
    // head 'r' requires a 19-char integer part; the key is 9 chars -> invalid.
    expect(isValidIndex(LEGACY_ILLEGAL)).toBe(false)
    // the library itself agrees it is not a legal order key.
    expect(acceptedByFractionalIndexing(LEGACY_ILLEGAL)).toBe(false)
  })

  it('still accepts genuine Excalidraw keys and still rejects bad charset', () => {
    expect(isValidIndex('a0')).toBe(true)
    expect(isValidIndex('a1')).toBe(true)
    expect(isValidIndex('Zz')).toBe(true)
    expect(isValidIndex('a!b')).toBe(false) // out-of-alphabet char
    expect(isValidIndex('')).toBe(false)
    expect(isValidIndex(undefined)).toBe(false)
  })

  it('normalizeElement strips a persisted illegal r-prefixed index to absent', () => {
    const n = normalizeElement({ id: 'x', type: 'rectangle', index: LEGACY_ILLEGAL })!
    expect('index' in n).toBe(false)
  })
})

describe('XIN-794 — repair fills a LEGAL fractional-index key', () => {
  it('does not emit the illegal r+base36 key for an indexless element', () => {
    const doc = buildDoc({ a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1 } })
    expect(repairLiveDoc(doc)).toBe(true)
    const idx = readElements(doc).get('a')!.index as string
    expect(typeof idx).toBe('string')
    expect(idx).not.toMatch(LEGACY_ILLEGAL_SHAPE) // was 'r00000000'
    expect(acceptedByFractionalIndexing(idx)).toBe(true)
    expect(isValidIndex(idx)).toBe(true)
  })

  it('re-writes a persisted illegal index to a legal one and is then idempotent', () => {
    const doc = buildDoc({
      a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1, index: LEGACY_ILLEGAL },
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const idx = readElements(doc).get('a')!.index as string
    expect(idx).not.toMatch(LEGACY_ILLEGAL_SHAPE)
    expect(isValidIndex(idx)).toBe(true)
    // second pass: the key is now legal, nothing left to fix.
    expect(repairLiveDoc(doc)).toBe(false)
  })

  it('appends filled keys AFTER existing valid indices (no collision, order kept)', () => {
    const doc = buildDoc({
      keep: { id: 'keep', type: 'rectangle', version: 1, versionNonce: 1, index: 'a5' },
      fillme: { id: 'fillme', type: 'rectangle', version: 1, versionNonce: 1 },
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const kept = readElements(doc).get('keep')!.index as string
    const filled = readElements(doc).get('fillme')!.index as string
    expect(kept).toBe('a5') // untouched
    expect(isValidIndex(filled)).toBe(true)
    expect(filled > kept).toBe(true) // filled sorts after the existing key
    expect(readElements(doc).get('keep')!.index).toBe('a5')
  })

  it('generates a distinct legal key per indexless element (no duplicates)', () => {
    const doc = buildDoc({
      a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1 },
      b: { id: 'b', type: 'rectangle', version: 1, versionNonce: 1 },
      c: { id: 'c', type: 'rectangle', version: 1, versionNonce: 1 },
    })
    repairLiveDoc(doc)
    const idxs = ['a', 'b', 'c'].map((id) => readElements(doc).get(id)!.index as string)
    idxs.forEach((i) => expect(isValidIndex(i)).toBe(true))
    expect(new Set(idxs).size).toBe(3) // all distinct
    expect([...idxs].sort()).toEqual(idxs) // ascending in id order
  })
})
