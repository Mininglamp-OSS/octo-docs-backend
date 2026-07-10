/**
 * XIN-794 / XIN-805 — CLI safety envelope for the one-off migration
 * (scripts/repairFractionalIndices.ts). The pure detection/repair logic is
 * covered by whiteboardFractionalIndexMigration.test.ts; this file exercises
 * the MySQL-wired wrapper with the pool + repo mocked, proving the operational
 * guarantees the ops runbook depends on:
 *   - dry-run (default) writes NOTHING (no transaction, no upsert),
 *   - --apply writes only the victims and re-repairs them to legal keys,
 *   - the `^r[0-9a-z]{8}$` reverse-find never flags a legitimate key,
 *   - one victim failing does not abort the batch (per-doc fault isolation),
 *   - a second --apply is a no-op (idempotent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { ELEMENTS_FIELD, isValidIndex } from '../src/whiteboard/schema/index.js'
import { readElements } from '../src/whiteboard/ydoc.js'

// In-memory yjs_document store shared between the pool/repo mocks and the tests.
const h = vi.hoisted(() => {
  const store = new Map<string, Buffer>()
  const upsertStateTx = vi.fn(async (_tx: unknown, name: string, state: Buffer) => {
    store.set(name, Buffer.from(state))
  })
  const selectForUpdateTx = vi.fn(async (_tx: unknown, name: string) => {
    const buf = store.get(name)
    return buf ? new Uint8Array(buf) : null
  })
  // scanVictims issues one SELECT; return every row in the store.
  const query = vi.fn(async () =>
    [...store.entries()].map(([document_name, state]) => ({ document_name, state })),
  )
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) as unknown
  return { store, upsertStateTx, selectForUpdateTx, query, transaction }
})

vi.mock('../src/db/pool.js', () => ({
  query: h.query,
  transaction: h.transaction,
  closePool: vi.fn(async () => {}),
}))

vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: {
    selectForUpdateTx: h.selectForUpdateTx,
    upsertStateTx: h.upsertStateTx,
  },
}))

import { runMigration } from '../scripts/repairFractionalIndices.js'

function encodeDoc(elements: Record<string, Record<string, unknown>>): Buffer {
  const doc = new Y.Doc()
  doc.transact(() => {
    const el = doc.getMap(ELEMENTS_FIELD)
    for (const [id, obj] of Object.entries(elements)) {
      const m = new Y.Map()
      for (const [k, v] of Object.entries(obj)) m.set(k, v)
      el.set(id, m as Y.Map<unknown>)
    }
  })
  const out = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return out
}

function element(index: unknown): Record<string, unknown> {
  return { id: 'x', type: 'rectangle', version: 1, versionNonce: 1, index }
}

/** Every persisted index in a stored doc is legal. */
function storedIndicesAllLegal(name: string): boolean {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, h.store.get(name)!)
  const ok = [...readElements(doc).values()].every((el) => isValidIndex(el.index))
  doc.destroy()
  return ok
}

const VICTIM = 'octo:space:folder:wb:victim'
const LEGIT = 'octo:space:folder:wb:legit'

beforeEach(() => {
  h.store.clear()
  h.upsertStateTx.mockClear()
  h.selectForUpdateTx.mockClear()
  h.query.mockClear()
  ;(h.transaction as ReturnType<typeof vi.fn>).mockClear()
  ;(h.transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  )
})

describe('XIN-805 migration CLI — dry-run safety', () => {
  it('DRY RUN detects victims but never opens a transaction or writes', async () => {
    h.store.set(VICTIM, encodeDoc({ x: element('r00000003') }))
    const legitBytes = encodeDoc({ x: element('a0') })
    h.store.set(LEGIT, legitBytes)

    const result = await runMigration(false)

    expect(result.mode).toBe('DRY RUN')
    expect(result.total).toBe(1) // only the illegal doc is a victim
    expect(result.migrated).toBe(0)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.selectForUpdateTx).not.toHaveBeenCalled()
    expect(h.upsertStateTx).not.toHaveBeenCalled()
    // legit doc left untouched (same bytes still in the store)
    expect(h.store.get(LEGIT)).toBe(legitBytes)
  })
})

describe('XIN-805 migration CLI — reverse-find precision', () => {
  it('flags only the exact r+8-base36 shape, never a legitimate key', async () => {
    // Legit keys of assorted shapes, including a real long r-headed jitterbug
    // key (head "r" => 19-char integer part, ≥20 chars total) and near-misses
    // of the illegal shape (7 and 9 trailing chars).
    h.store.set('octo:s:f:wb:a', encodeDoc({ x: element('a0') }))
    h.store.set('octo:s:f:wb:long', encodeDoc({ x: element('r0zzzzzzzzzzzzzzzz1') })) // 19 chars, legit
    h.store.set('octo:s:f:wb:short7', encodeDoc({ x: element('r0000000') })) // 7 digits
    h.store.set('octo:s:f:wb:long9', encodeDoc({ x: element('r000000000') })) // 9 digits
    // A non-whiteboard document key must be skipped entirely.
    h.store.set('octo:s:f:plaindoc', encodeDoc({ x: element('r00000003') }))
    // The single true victim.
    h.store.set(VICTIM, encodeDoc({ x: element('r00000003') }))

    const result = await runMigration(false)

    expect(result.total).toBe(1)
    expect(h.upsertStateTx).not.toHaveBeenCalled()
  })
})

describe('XIN-805 migration CLI — apply writes only victims and is idempotent', () => {
  it('APPLY re-repairs the victim to legal keys and writes it once', async () => {
    h.store.set(VICTIM, encodeDoc({ x: element('r00000003') }))
    h.store.set(LEGIT, encodeDoc({ x: element('a0') }))

    const first = await runMigration(true)

    expect(first.mode).toBe('APPLY')
    expect(first.migrated).toBe(1)
    expect(first.failed).toEqual([])
    // exactly the victim was upserted; the legit doc was never scanned for write
    expect(h.upsertStateTx).toHaveBeenCalledTimes(1)
    expect(h.upsertStateTx.mock.calls[0]![1]).toBe(VICTIM)
    expect(storedIndicesAllLegal(VICTIM)).toBe(true)

    // second --apply is idempotent: the re-repaired doc no longer carries a
    // legacy illegal key, so the rescan finds no victim and writes nothing.
    h.upsertStateTx.mockClear()
    const second = await runMigration(true)
    expect(second.total).toBe(0)
    expect(second.migrated).toBe(0)
    expect(second.failed).toEqual([])
    expect(h.upsertStateTx).not.toHaveBeenCalled()
  })
})

describe('XIN-805 migration CLI — fault isolation', () => {
  it('one victim failing does not abort the batch; others still migrate', async () => {
    const BAD = 'octo:space:folder:wb:bad'
    const GOOD = 'octo:space:folder:wb:good'
    h.store.set(BAD, encodeDoc({ x: element('r00000003') }))
    h.store.set(GOOD, encodeDoc({ x: element('r00000005') }))

    // Fail the write for BAD only; GOOD must still be repaired.
    h.upsertStateTx.mockImplementation(async (_tx: unknown, name: string, state: Buffer) => {
      if (name === BAD) throw new Error('deadlock found when trying to get lock')
      h.store.set(name, Buffer.from(state))
    })

    const result = await runMigration(true)

    expect(result.total).toBe(2)
    expect(result.migrated).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.documentName).toBe(BAD)
    expect(result.failed[0]!.error).toContain('deadlock')
    // the healthy doc was still written and is now legal
    expect(storedIndicesAllLegal(GOOD)).toBe(true)
    // both victims were attempted (fault isolation, not fast-fail)
    expect(h.upsertStateTx).toHaveBeenCalledTimes(2)
  })
})
