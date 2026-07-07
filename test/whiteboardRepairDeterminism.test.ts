/**
 * BE-M11 — server-authoritative repair WRITE-BACK DETERMINISM (XIN-21 / XIN-26).
 *
 * The same illegal state (one persisted Y.Doc blob) is cold-started and repaired
 * independently on N >= 3 instances/workers (failover / multi-owner). The
 * authoritative repair MUST converge byte-identically:
 *   - encodeStateAsUpdate byte-equal pairwise,
 *   - same fractional-index (z-order) key sequence,
 *   - same surviving element set,
 *   - any two instances' diff is empty (already-converged).
 *
 * This nails "server-authoritative single write-back + cross-cluster diff-empty
 * fallback" determinism; it is NOT subsumed by the idempotence/anti-self-excite
 * tests. Pairs with the front-end T20/M-11 (binding side).
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { repairWhiteboardState } from '../src/whiteboard/repair.js'
import { repairLiveDoc } from '../src/whiteboard/repair.js'
import { readElements } from '../src/whiteboard/ydoc.js'
import { ELEMENTS_FIELD, FILES_FIELD, REPAIR_CLIENT_ID } from '../src/whiteboard/schema/index.js'

const N = 4 // >= 3 independent instances

/** Build ONE illegal persisted state (the shared DB blob all instances load). */
function buildIllegalState(): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    const el = doc.getMap(ELEMENTS_FIELD)
    const fl = doc.getMap(FILES_FIELD)
    const put = (id: string, obj: Record<string, unknown>) => {
      const m = new Y.Map()
      for (const [k, v] of Object.entries(obj)) m.set(k, v)
      el.set(id, m as Y.Map<unknown>)
    }
    // inserted out of id order, with assorted illegal fields:
    put('e_z', { id: 'e_z', type: 'rectangle', version: 0, x: NaN, opacity: 9000 })
    put('e_a', { id: 'e_a', type: 'ellipse', version: 'oops' as unknown as number, width: -5 })
    put('e_m', { id: 'e_m', type: 'rectangle', index: 'bad idx!', extraFuture: { k: 1 } })
    put('e_bad', { id: 'e_bad', type: 'wormhole', version: 3 }) // unknown type -> dropped
    // M-5: a bound text whose container element was deleted -> dangling
    // containerId. The container 'e_ghost' is never inserted, so repair must
    // clear containerId to null (same shape as the frameId rule). This is the
    // only element exercising the M-5 clear path in the determinism suite, so
    // its presence is what proves M-5 converges byte-identically across nodes.
    put('e_txt', { id: 'e_txt', type: 'text', version: 1, versionNonce: 11, index: 'a2', containerId: 'e_ghost' })
    put('img_ok', { id: 'img_ok', type: 'image', version: 1, versionNonce: 7, index: 'a0', fileId: 'f_ok' })
    put('img_dangling', { id: 'img_dangling', type: 'image', version: 1, versionNonce: 7, fileId: 'missing' })
    const f = new Y.Map()
    f.set('attachId', 'f_ok')
    f.set('mimeType', 'image/png')
    fl.set('f_ok', f as Y.Map<unknown>)
    const orphan = new Y.Map()
    orphan.set('attachId', 'f_orphan')
    fl.set('f_orphan', orphan as Y.Map<unknown>)
  }, 'seed')
  const out = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return out
}

function decode(state: Uint8Array): Y.Doc {
  const d = new Y.Doc()
  Y.applyUpdate(d, state)
  return d
}

/** id order sorted by fractional index then id (z-order projection). */
function zOrder(state: Uint8Array): string[] {
  const doc = decode(state)
  const els = [...readElements(doc).entries()]
  doc.destroy()
  return els
    .sort((a, b) => {
      const ia = String(a[1].index ?? '')
      const ib = String(b[1].index ?? '')
      return ia < ib ? -1 : ia > ib ? 1 : a[0] < b[0] ? -1 : 1
    })
    .map(([id]) => id)
}

describe('BE-M11 repair write-back determinism', () => {
  const input = buildIllegalState()
  const results = Array.from({ length: N }, () => repairWhiteboardState(input))

  it('actually repairs the illegal input (changed = true, output != input)', () => {
    expect(results[0].changed).toBe(true)
    expect(Buffer.from(results[0].state)).not.toEqual(Buffer.from(input))
  })

  it('produces byte-identical encodeStateAsUpdate across all N instances', () => {
    const ref = Buffer.from(results[0].state)
    for (let i = 1; i < N; i++) {
      expect(Buffer.from(results[i].state)).toEqual(ref)
    }
  })

  it('produces the same surviving element set (drops bad-type + dangling-image)', () => {
    const doc = decode(results[0].state)
    const ids = [...readElements(doc).keys()].sort()
    doc.destroy()
    expect(ids).toEqual(['e_a', 'e_m', 'e_txt', 'e_z', 'img_ok'])
  })

  it('clears the dangling containerId (M-5) byte-identically across instances', () => {
    // The repaired e_txt must have its dangling containerId nulled, and because
    // this is part of the byte-equal output above, every instance agrees — i.e.
    // the M-5 clear path is exercised AND deterministic, not just unit-tested.
    for (let i = 0; i < N; i++) {
      const doc = decode(results[i].state)
      const txt = readElements(doc).get('e_txt')!
      doc.destroy()
      expect(txt.containerId).toBeNull()
    }
  })

  it('produces an identical fractional-index (z-order) key sequence across instances', () => {
    const ref = zOrder(results[0].state)
    for (let i = 1; i < N; i++) expect(zOrder(results[i].state)).toEqual(ref)
    // every surviving element carries a valid index after repair
    const doc = decode(results[0].state)
    for (const el of readElements(doc).values()) {
      expect(typeof el.index).toBe('string')
      expect((el.index as string).length).toBeGreaterThan(0)
    }
    doc.destroy()
  })

  it('has empty pairwise diff (merging any instance into any other is a no-op)', () => {
    // "diff empty" semantics: instances are already converged, so merging one
    // into another adds nothing — the canonical re-encode is unchanged. (A raw
    // Y.diffUpdate is NOT [0,0] here because the repaired state carries a delete
    // set from the dropped/GC'd entries; convergence is what we assert.)
    const ref = Buffer.from(results[0].state)
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue
        const doc = decode(results[i].state)
        Y.applyUpdate(doc, results[j].state)
        const merged = Buffer.from(Y.encodeStateAsUpdate(doc))
        doc.destroy()
        expect(merged).toEqual(ref)
      }
    }
  })

  it('is stable under re-repair (repairing the repaired output is a no-op)', () => {
    // Production cold-start re-loads persisted bytes (random client) and runs
    // the live repair pass; an already-repaired state must yield no change.
    const doc = decode(results[0].state)
    expect(repairLiveDoc(doc)).toBe(false)
    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(Buffer.from(results[0].state))
    doc.destroy()
  })

  it('CONTROL: the fixed REPAIR_CLIENT_ID is what makes it deterministic', () => {
    // Without a pinned client id, two instances repairing the same input emit
    // DIFFERENT bytes (new structs attributed to different random clients).
    const mk = (clientId: number) => {
      const d = new Y.Doc()
      d.clientID = clientId
      Y.applyUpdate(d, input)
      repairLiveDoc(d)
      const b = Y.encodeStateAsUpdate(d)
      d.destroy()
      return Buffer.from(b)
    }
    expect(mk(1001)).not.toEqual(mk(2002)) // divergence without the fix
    expect(mk(REPAIR_CLIENT_ID)).toEqual(Buffer.from(results[0].state)) // fix converges
  })
})
