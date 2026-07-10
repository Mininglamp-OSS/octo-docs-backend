import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

/**
 * Regression (XIN-749 B1): `GET /:docId/export` is a pure READ, but it opens a
 * DirectConnection (via readLiveDocState, as the `system` sentinel) and
 * disconnects — and @hocuspocus/server flushes onStoreDocument ->
 * persistence.store UNCONDITIONALLY on disconnect. Before the shared XIN-743
 * fix, that flush re-stamped doc_meta.updated_by='system' and bumped updated_at
 * on every export, silently rewriting the board's authoritative "last edited
 * by". Same root cause as #41 (readLiveDocState) / #48 (readLiveBoard).
 *
 * This drives the REAL export handler through the REAL readLiveDocState + REAL
 * persistence.store, with a fake collab server whose disconnect() performs the
 * store flush exactly as hocuspocus does on unload (with the connection's user
 * context). It asserts the export routes through the protected sentinel and
 * issues NO `UPDATE doc_meta` — the Y.Doc row is still upserted (idempotent for
 * a read). Reverting the SYSTEM_STORE_UID guard in persistence.store fails this.
 */

const cap = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }> }))

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
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
// No images in this scene → listByDoc returns []; object store untouched.
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { listByDoc: vi.fn(async () => []), getById: vi.fn(async () => null) },
}))

// Fake collab server: openDirectConnection hands back the live Y.Doc and, on
// disconnect(), performs the store flush hocuspocus does on unload — calling the
// REAL persistence.store with the connection's `system` sentinel user context.
const srv = vi.hoisted(() => ({ opts: [] as Array<{ user?: { id?: string } }>, liveDoc: null as unknown as Y.Doc, name: '' }))
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({
    hocuspocus: {
      openDirectConnection: async (name: string, opts: { user?: { id?: string } }) => {
        srv.opts.push(opts)
        srv.name = name
        return {
          transact: async (cb: (doc: Y.Doc) => void) => {
            srv.liveDoc.transact(() => cb(srv.liveDoc))
          },
          disconnect: async () => {
            const state = Y.encodeStateAsUpdate(srv.liveDoc)
            await persistence.store(srv.name, state, { user: { id: opts.user?.id } })
          },
        }
      },
    },
  }),
}))

import { persistence, SYSTEM_STORE_UID } from '../src/collab/persistence.js'
import { exportBoardHandler } from '../src/api/routes/boardExport.js'
import { requireDocRole } from '../src/api/guard.js'

function boardDoc(): Y.Doc {
  const doc = new Y.Doc()
  const elMap = doc.getMap('elements')
  doc.transact(() => {
    const y = new Y.Map<unknown>()
    const el = { id: 'r1', type: 'rectangle', index: 'a0', x: 0, y: 0, width: 100, height: 50, isDeleted: false }
    for (const [k, v] of Object.entries(el)) y.set(k, v)
    elMap.set('r1', y)
  })
  doc.getMap('files')
  return doc
}

const boardGuard = {
  meta: { doc_id: 'b_1', document_name: 'octo:s1:f_default:wb:b_1', doc_type: 'board' },
  role: 'reader',
} as never

interface MockRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  contentType: string
  status(c: number): MockRes
  json(b: unknown): MockRes
  send(b: unknown): MockRes
  type(t: string): MockRes
  setHeader(k: string, v: string): void
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    contentType: '',
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
    send(b) {
      this.body = b
      return this
    },
    type(t) {
      this.contentType = t
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
  }
}
function req(params: Record<string, string>, query: Record<string, unknown> = {}) {
  return { uid: 'u_1', spaceId: 's1', params, query } as never
}

describe('GET /:docId/export — read must not pollute doc_meta (XIN-749 B1)', () => {
  beforeEach(() => {
    cap.queries.length = 0
    srv.opts.length = 0
    srv.liveDoc = boardDoc()
    vi.mocked(requireDocRole).mockReset()
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
  })

  it('connects as the system sentinel and never stamps doc_meta.updated_by/updated_at', async () => {
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }, { format: 'svg' }), res as never)

    // The export succeeded...
    expect(res.statusCode).toBe(200)
    // ...the live read connected as the protected `system` sentinel...
    expect(srv.opts.at(-1)).toEqual({ user: { id: SYSTEM_STORE_UID } })
    // ...the disconnect store flush still upserted the Y.Doc row (idempotent)...
    const { yjsDocumentRepo } = await import('../src/db/repos/yjsDocumentRepo.js')
    expect(yjsDocumentRepo.upsertStateTx).toHaveBeenCalled()
    // ...but doc_meta ownership metadata was NEVER rewritten by the read.
    expect(cap.queries.some((q) => /UPDATE doc_meta/i.test(q.sql))).toBe(false)
  })
})
