import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  repairLiveDoc,
  attachWhiteboardRepair,
} from '../src/whiteboard/repair.js'
import { readElements, getFilesMap } from '../src/whiteboard/ydoc.js'
import {
  ELEMENTS_FIELD,
  FILES_FIELD,
  REPAIR_ORIGIN,
  deterministicNonce,
} from '../src/whiteboard/schema/index.js'

type Obj = Record<string, unknown>

function buildDoc(elements: Record<string, Obj>, files: Record<string, Obj> = {}): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const el = doc.getMap(ELEMENTS_FIELD)
    const fl = doc.getMap(FILES_FIELD)
    for (const [id, obj] of Object.entries(elements)) {
      const m = new Y.Map()
      for (const [k, v] of Object.entries(obj)) m.set(k, v)
      el.set(id, m as Y.Map<unknown>)
    }
    for (const [id, obj] of Object.entries(files)) {
      const m = new Y.Map()
      for (const [k, v] of Object.entries(obj)) m.set(k, v)
      fl.set(id, m as Y.Map<unknown>)
    }
  }, 'seed')
  return doc
}

/** A pre-normalized, clean element so repair has nothing to do. */
function clean(id: string, index: string, extra: Obj = {}): Obj {
  return { id, type: 'rectangle', version: 1, versionNonce: deterministicNonce(`${id}:1`), index, ...extra }
}

describe('repairLiveDoc — diff-empty gate (§4.1 gate 2)', () => {
  it('opens NO transaction for an already-clean doc (returns false, no version churn)', () => {
    const doc = buildDoc({ a: clean('a', 'a0'), b: clean('b', 'a1') })
    const before = Y.encodeStateAsUpdate(doc)
    expect(repairLiveDoc(doc)).toBe(false)
    // byte-identical state: a clean doc is untouched
    expect(Buffer.from(Y.encodeStateAsUpdate(doc))).toEqual(Buffer.from(before))
  })
})

describe('repairLiveDoc — normalization + idempotence', () => {
  it('coerces illegal fields and is idempotent on a second pass', () => {
    const doc = buildDoc({
      a: { id: 'a', type: 'rectangle', version: 0, x: NaN, opacity: 999 },
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const a = readElements(doc).get('a')!
    expect(a.version).toBe(1)
    expect(a.x).toBe(0)
    expect(a.opacity).toBe(100)
    expect(a.versionNonce).toBe(deterministicNonce('a:1'))
    // second pass: nothing left to fix
    expect(repairLiveDoc(doc)).toBe(false)
  })

  it('assigns a deterministic index to an indexless element', () => {
    const doc = buildDoc({ a: { id: 'a', type: 'rectangle', version: 1, versionNonce: 1 } })
    expect(repairLiveDoc(doc)).toBe(true)
    const idx = readElements(doc).get('a')!.index
    expect(typeof idx).toBe('string')
    expect((idx as string).length).toBeGreaterThan(0)
    expect(repairLiveDoc(doc)).toBe(false) // stable
  })

  it('preserves unknown fields through repair (§6)', () => {
    const doc = buildDoc({
      a: { id: 'a', type: 'rectangle', version: 0, customXYZ: { keep: 1 }, futureFlag: true },
    })
    repairLiveDoc(doc)
    const a = readElements(doc).get('a')!
    expect(a.customXYZ).toEqual({ keep: 1 })
    expect(a.futureFlag).toBe(true)
  })

  it('drops unrenderable (unknown-type) elements', () => {
    const doc = buildDoc({
      good: clean('good', 'a0'),
      bad: { id: 'bad', type: 'wormhole', version: 1 },
    })
    repairLiveDoc(doc)
    const ids = [...readElements(doc).keys()]
    expect(ids).toContain('good')
    expect(ids).not.toContain('bad')
  })
})

describe('repairLiveDoc — files (§2) dangling image drop + GC', () => {
  it('drops an image with a dangling fileId and GCs unreferenced files', () => {
    const doc = buildDoc(
      {
        img1: { id: 'img1', type: 'image', version: 1, versionNonce: 1, index: 'a0', fileId: 'present' },
        img2: { id: 'img2', type: 'image', version: 1, versionNonce: 1, index: 'a1', fileId: 'gone' },
      },
      {
        present: { attachId: 'present', mimeType: 'image/png' },
        orphan: { attachId: 'orphan', mimeType: 'image/png' },
      },
    )
    repairLiveDoc(doc)
    const ids = [...readElements(doc).keys()]
    expect(ids).toContain('img1') // file present -> kept
    expect(ids).not.toContain('img2') // dangling fileId -> dropped
    const fileIds = [...getFilesMap(doc).keys()].sort()
    // 'present' still referenced by img1; 'orphan' + 'gone' (never existed) GC'd
    expect(fileIds).toEqual(['present'])
  })
})

describe('repairLiveDoc — M-5 dangling containerId cleanup (§3.6.2/§3.6.3)', () => {
  it('clears a bound-text containerId whose container element was deleted, server-authoritative', () => {
    // A text bound to a 'box' container; the box was never persisted (deleted), so the
    // text is an orphaned bound-text with a dangling containerId. Repair must null it
    // (same shape as the frameId rule) and write the corrected value back to the live doc.
    const doc = buildDoc({
      t: clean('t', 'a0', { type: 'text', containerId: 'box' }),
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const t = readElements(doc).get('t')!
    expect(t.containerId).toBeNull()
    // idempotent: a second pass has nothing left to fix
    expect(repairLiveDoc(doc)).toBe(false)
  })

  it('keeps a containerId whose container element survives (no churn)', () => {
    const doc = buildDoc({
      box: clean('box', 'a0'),
      t: clean('t', 'a1', { type: 'text', containerId: 'box' }),
    })
    // both elements are already canonical -> no corrective transaction
    expect(repairLiveDoc(doc)).toBe(false)
    expect(readElements(doc).get('t')!.containerId).toBe('box')
  })

  it('clears containerId but preserves unknown fields on the orphaned text (§6)', () => {
    const doc = buildDoc({
      t: clean('t', 'a0', { type: 'text', containerId: 'gone', boundFlavor: { keep: 1 } }),
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const t = readElements(doc).get('t')!
    expect(t.containerId).toBeNull()
    expect(t.boundFlavor).toEqual({ keep: 1 })
  })

  it('prunes a containerId pointing at a TOMBSTONED container, not only a hard-absent one (P1-2)', () => {
    // The container is present but soft-deleted (isDeleted === true). Deletions
    // are tombstones that KEEP the key (§1.1), so the container id is still in
    // the elements map — but it must NOT count as a valid reference target. The
    // bound text's containerId therefore has to be pruned exactly as if the
    // container were hard-absent.
    const doc = buildDoc({
      box: clean('box', 'a0', { isDeleted: true }),
      t: clean('t', 'a1', { type: 'text', containerId: 'box' }),
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const t = readElements(doc).get('t')!
    expect(t.containerId).toBeNull()
    // the tombstoned container keeps its key — repair never hard-deletes it.
    expect(readElements(doc).has('box')).toBe(true)
    expect((readElements(doc).get('box') as Record<string, unknown>).isDeleted).toBe(true)
    // idempotent: the ref is already pruned on a second pass.
    expect(repairLiveDoc(doc)).toBe(false)
  })

  it('also prunes boundElements / frameId that point at a tombstoned element (P1-2)', () => {
    const doc = buildDoc({
      frame: clean('frame', 'a0', { isDeleted: true }),
      child: clean('child', 'a1', {
        frameId: 'frame',
        boundElements: [{ id: 'frame', type: 'text' }],
      }),
    })
    expect(repairLiveDoc(doc)).toBe(true)
    const child = readElements(doc).get('child')!
    expect(child.frameId).toBeNull()
    expect(child.boundElements).toEqual([]) // dangling bound ref filtered out
  })
})

describe('attachWhiteboardRepair — live observer (§4.1 gates 1 & 3)', () => {
  it('repairs a user write and does not self-excite (origin skip)', () => {
    const doc = buildDoc({})
    let repairTxns = 0
    // count REPAIR_ORIGIN transactions to prove repair runs but does not loop
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      if (txn.origin === REPAIR_ORIGIN) repairTxns++
    })
    const dispose = attachWhiteboardRepair(doc)
    // a user introduces an illegal element
    doc.transact(() => {
      const m = new Y.Map()
      m.set('id', 'a')
      m.set('type', 'rectangle')
      m.set('version', 0)
      m.set('x', NaN)
      doc.getMap(ELEMENTS_FIELD).set('a', m as Y.Map<unknown>)
    }, 'user')
    const a = readElements(doc).get('a')!
    expect(a.version).toBe(1)
    expect(a.x).toBe(0)
    // exactly one corrective transaction — the observer skipped its own write
    expect(repairTxns).toBe(1)
    dispose()
  })

  it('disposer detaches the observer (no repair after dispose)', () => {
    const doc = buildDoc({})
    const dispose = attachWhiteboardRepair(doc)
    dispose()
    doc.transact(() => {
      const m = new Y.Map()
      m.set('id', 'b')
      m.set('type', 'rectangle')
      m.set('version', 0)
      doc.getMap(ELEMENTS_FIELD).set('b', m as Y.Map<unknown>)
    }, 'user')
    // not repaired (observer detached) -> illegal version remains
    expect(readElements(doc).get('b')!.version).toBe(0)
  })

  it('re-prunes a dependent when its container is HARD-deleted live (P1-3 scope expansion)', () => {
    // box + a bound text, both already canonical so the load pass is quiet.
    const doc = buildDoc({
      box: clean('box', 'a0'),
      t: clean('t', 'a1', { type: 'text', containerId: 'box' }),
    })
    const dispose = attachWhiteboardRepair(doc)
    // A user hard-deletes the container. Only `box` is in the transaction scope;
    // the surviving text `t` did NOT change, yet its containerId now dangles and
    // must be re-pruned (the scope is expanded to `box`'s referrers).
    doc.transact(() => {
      doc.getMap(ELEMENTS_FIELD).delete('box')
    }, 'user')
    expect(readElements(doc).has('box')).toBe(false)
    expect(readElements(doc).get('t')!.containerId).toBeNull()
    dispose()
  })

  it('re-prunes a dependent when its container is TOMBSTONED live (P1-3, tombstone shape)', () => {
    const doc = buildDoc({
      box: clean('box', 'a0'),
      t: clean('t', 'a1', { type: 'text', containerId: 'box' }),
    })
    const dispose = attachWhiteboardRepair(doc)
    // Soft-delete: flip isDeleted on the container. `box` keeps its key, so only
    // `box` is in scope, but the text bound to it must still be re-pruned.
    doc.transact(() => {
      ;(doc.getMap(ELEMENTS_FIELD).get('box') as Y.Map<unknown>).set('isDeleted', true)
    }, 'user')
    expect(readElements(doc).get('t')!.containerId).toBeNull()
    dispose()
  })
})
