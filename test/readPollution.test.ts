import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

/**
 * Regression: a pure scene/content READ must never re-stamp the document's
 * authoritative last-editor metadata (Jerry-Xin + OctoBoooot blocking finding).
 *
 * The read paths (readLiveBoard / readLiveSheet / readLiveDocState) open a
 * DirectConnection as the `system` sentinel and disconnect(); @hocuspocus/server
 * flushes onStoreDocument -> persistence.store UNCONDITIONALLY on disconnect, so
 * before the fix every GET /:docId/scene and every PATCH pre-flight rewrote
 * doc_meta.updated_by = 'system' and bumped updated_at. The fix is at the shared
 * store chokepoint, so it covers the board, sheet, and doc read paths at once.
 *
 * Part A pins the root-cause behaviour of persistence.store; Part B pins that the
 * board AND sheet read paths route through the protected `system` sentinel.
 */

const cap = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }> }))

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        cap.queries.push({ sql, params })
        return []
      },
    }),
  ),
}))
vi.mock('../src/db/repos/yjsDocumentRepo.js', () => ({
  yjsDocumentRepo: {
    fetchState: vi.fn(async () => null),
    selectForUpdateTx: vi.fn(async () => null),
    upsertStateTx: vi.fn(async () => {}),
  },
}))

// Fake collab server backed by a real Y.Doc, capturing the openDirectConnection
// options so we can assert which uid a read path connects as.
const srv = vi.hoisted(() => ({ opts: [] as unknown[], liveDoc: null as unknown as Y.Doc }))
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({
    hocuspocus: {
      openDirectConnection: async (_name: string, opts: unknown) => {
        srv.opts.push(opts)
        return {
          transact: async (cb: (doc: Y.Doc) => void) => {
            srv.liveDoc.transact(() => cb(srv.liveDoc))
          },
          disconnect: async () => {},
        }
      },
    },
  }),
}))

import { persistence, SYSTEM_STORE_UID } from '../src/collab/persistence.js'
import { readLiveBoard } from '../src/collab/liveBoardWrite.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'

function smallUpdate(): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => doc.getText('t').insert(0, 'hi'))
  return Y.encodeStateAsUpdate(doc)
}

const DOC = 'octo:s1:f_default:doc:d_1'

beforeEach(() => {
  cap.queries.length = 0
  srv.opts.length = 0
  srv.liveDoc = new Y.Doc()
})

describe('persistence.store — read-only sentinel does not touch doc_meta (defect 1 root cause)', () => {
  it('skips the doc_meta updated_by/updated_at write for the system sentinel', async () => {
    await persistence.store(DOC, smallUpdate(), { user: { id: SYSTEM_STORE_UID } })
    // The authoritative row is still upserted (idempotent for a read)...
    const { yjsDocumentRepo } = await import('../src/db/repos/yjsDocumentRepo.js')
    expect(yjsDocumentRepo.upsertStateTx).toHaveBeenCalledTimes(1)
    // ...but the ownership metadata is never stamped.
    expect(cap.queries.some((q) => /UPDATE doc_meta/i.test(q.sql))).toBe(false)
  })

  it('still stamps updated_by/updated_at for a real editor uid', async () => {
    await persistence.store(DOC, smallUpdate(), { user: { id: 'u_real' } })
    const meta = cap.queries.find((q) => /UPDATE doc_meta/i.test(q.sql))
    expect(meta).toBeDefined()
    expect(meta!.params).toEqual(['u_real', DOC])
  })

  it('records updated_by = null (not the sentinel) when no user context is present', async () => {
    await persistence.store(DOC, smallUpdate(), undefined)
    const meta = cap.queries.find((q) => /UPDATE doc_meta/i.test(q.sql))
    expect(meta).toBeDefined()
    expect(meta!.params).toEqual([null, DOC])
  })
})

describe('read paths connect as the system sentinel (defect 1 — board + sheet coverage)', () => {
  it('readLiveBoard opens the direct connection as the system sentinel', async () => {
    await readLiveBoard('octo:s1:f_default:wb:b_1')
    expect(srv.opts.at(-1)).toEqual({ user: { id: SYSTEM_STORE_UID } })
  })

  it('readLiveSheet opens the direct connection as the system sentinel', async () => {
    await readLiveSheet(DOC)
    expect(srv.opts.at(-1)).toEqual({ user: { id: SYSTEM_STORE_UID } })
  })
})
