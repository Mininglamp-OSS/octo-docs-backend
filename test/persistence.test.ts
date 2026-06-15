import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { computeFinalState, isEmptyUpdate } from '../src/collab/persistence.js'

function docWith(mutate: (doc: Y.Doc) => void): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  return doc
}

describe('merge-on-write computeFinalState (§3.2 / P1-D)', () => {
  it('writes incoming directly when there is no existing row', () => {
    const incoming = Y.encodeStateAsUpdate(docWith((d) => d.getText('t').insert(0, 'hello')))
    const { finalState, usedUnion } = computeFinalState(null, incoming)
    expect(usedUnion).toBe(false)
    expect(new Uint8Array(finalState)).toEqual(incoming)
  })

  it('single-writer path: incoming ⊇ existing => direct write, no union re-encode', () => {
    const base = docWith((d) => d.getText('t').insert(0, 'hello'))
    const existing = Y.encodeStateAsUpdate(base)
    // incoming continues from existing (superset).
    base.getText('t').insert(5, ' world')
    const incoming = Y.encodeStateAsUpdate(base)

    const { finalState, usedUnion } = computeFinalState(existing, incoming)
    expect(usedUnion).toBe(false)
    expect(new Uint8Array(finalState)).toEqual(incoming)
  })

  it('concurrency: incoming missing some existing edits => union, no edit lost', () => {
    // Two independent docs with concurrent edits (neither a superset).
    const a = docWith((d) => d.getText('t').insert(0, 'AAA'))
    const b = docWith((d) => d.getText('t').insert(0, 'BBB'))
    const existing = Y.encodeStateAsUpdate(a)
    const incoming = Y.encodeStateAsUpdate(b)

    const { finalState, usedUnion } = computeFinalState(existing, incoming)
    expect(usedUnion).toBe(true)

    // The merged state must contain BOTH a's and b's edits.
    const merged = new Y.Doc()
    Y.applyUpdate(merged, new Uint8Array(finalState))
    const text = merged.getText('t').toString()
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })

  it('STALE incoming (subset of existing) must NOT drop existing edits (direction guard)', () => {
    // existing has MORE than incoming; incoming is a stale subset.
    const shared = docWith((d) => d.getText('t').insert(0, 'base'))
    const incoming = Y.encodeStateAsUpdate(shared) // stale snapshot
    shared.getText('t').insert(4, '-extra')
    const existing = Y.encodeStateAsUpdate(shared) // newer, superset

    const { finalState } = computeFinalState(existing, incoming)
    const merged = new Y.Doc()
    Y.applyUpdate(merged, new Uint8Array(finalState))
    // 'extra' edits present only in existing must survive.
    expect(merged.getText('t').toString()).toContain('extra')
  })
})

describe('isEmptyUpdate', () => {
  it('recognizes the empty Yjs v1 update encoding', () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc(), Y.encodeStateVector(new Y.Doc()))
    expect(isEmptyUpdate(empty)).toBe(true)
  })
  it('a non-empty update is not empty', () => {
    const u = Y.encodeStateAsUpdate(docWith((d) => d.getText('t').insert(0, 'x')))
    expect(isEmptyUpdate(u)).toBe(false)
  })
})
