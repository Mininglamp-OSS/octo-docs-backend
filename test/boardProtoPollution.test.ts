import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  validateBoardOps,
  BoardElementInvalidError,
  BoardFileInvalidError,
} from '../src/whiteboard/boardEdit.js'
import { normalizeElement, normalizeFileRef } from '../src/whiteboard/schema/index.js'
import { getElementsMap, readEntry, readElements } from '../src/whiteboard/ydoc.js'

/**
 * Regression: reserved prototype keys in a scene element / file ref (XIN-743
 * defect 2, OctoBoooot major finding). A JSON request body carrying `__proto__`
 * (or `constructor` / `prototype`) produces a REAL own property — JSON.parse
 * uses define-semantics, not the `__proto__` setter — so it passed the type
 * whitelist, was stored as a Y.Map key, then corrupted the plain-object
 * read-back (readEntry's `obj[k] = v` reparented the object, dropped the key and
 * leaked inherited props). The fix rejects such keys fail-closed on write (both
 * the shared normalize layer and the `validateBoardOps` 422 surface) and
 * isolates them safely in readEntry on read. This also underpins the board
 * image-export decode path, which reuses readEntry.
 */

/** The exact failure input shape, parsed from JSON so the key is OWN. */
function elementWithReservedKey(reserved: string): Record<string, unknown> {
  return JSON.parse(
    `{"id":"x","type":"rectangle","version":2,"versionNonce":1,"${reserved}":{"evil":1}}`,
  ) as Record<string, unknown>
}

const RESERVED = ['__proto__', 'constructor', 'prototype'] as const

describe('normalizeElement rejects reserved prototype keys (defect 2)', () => {
  for (const key of RESERVED) {
    it(`returns null for an element carrying an own "${key}" key`, () => {
      expect(normalizeElement(elementWithReservedKey(key))).toBeNull()
    })
  }

  it('still normalizes a clean element (no false positive)', () => {
    const el = normalizeElement({ id: 'ok', type: 'rectangle', version: 1, versionNonce: 1 })
    expect(el).not.toBeNull()
    expect(el!.id).toBe('ok')
  })
})

describe('validateBoardOps surfaces reserved keys as 422 (defect 2)', () => {
  it('throws BoardElementInvalidError for an element with __proto__', () => {
    expect(() => validateBoardOps({ elements: [elementWithReservedKey('__proto__')] })).toThrow(
      BoardElementInvalidError,
    )
  })

  it('throws BoardFileInvalidError for a files entry with __proto__', () => {
    const ref = JSON.parse('{"attachId":"a1","__proto__":{"evil":1}}') as Record<string, unknown>
    expect(() => validateBoardOps({ files: { f1: ref } })).toThrow(BoardFileInvalidError)
  })

  it('normalizeFileRef rejects a reserved key even with a usable attachId', () => {
    const ref = JSON.parse('{"attachId":"a1","constructor":{"evil":1}}') as Record<string, unknown>
    expect(normalizeFileRef(ref)).toBeNull()
  })

  it('normalizeFileRef accepts a clean file ref (no false positive)', () => {
    expect(normalizeFileRef({ attachId: 'a1' })).not.toBeNull()
  })
})

describe('no global prototype pollution + read-back isolation (defect 2)', () => {
  it('rejecting the batch never pollutes Object.prototype', () => {
    for (const key of RESERVED) {
      try {
        validateBoardOps({ elements: [elementWithReservedKey(key)] })
      } catch {
        /* expected 422 */
      }
    }
    expect(({} as Record<string, unknown>).evil).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('evil')
  })

  it('readEntry isolates an already-stored __proto__ key as an OWN data prop (no reparent)', () => {
    const doc = new Y.Doc()
    const yEl = new Y.Map<unknown>()
    doc.transact(() => {
      // Simulate a legacy/pre-fix stored entry that already has the reserved key.
      yEl.set('id', 'legacy')
      yEl.set('__proto__', { evil: 1 })
      getElementsMap(doc).set('legacy', yEl)
    })

    const entry = readEntry(yEl)
    // The object is NOT reparented: its prototype is still Object.prototype and it
    // does not inherit `evil`.
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype)
    expect((entry as { evil?: unknown }).evil).toBeUndefined()
    // The key round-trips as a plain OWN data property rather than being dropped.
    expect(Object.prototype.hasOwnProperty.call(entry, '__proto__')).toBe(true)
    expect(entry.id).toBe('legacy')

    // The full read path is likewise safe.
    const all = readElements(doc)
    expect(Object.getPrototypeOf(all.get('legacy'))).toBe(Object.prototype)
  })
})
