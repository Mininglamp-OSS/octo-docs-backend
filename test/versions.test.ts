import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { gzipSync, gunzipSync } from 'node:zlib'

// Offline unit test: mock the auth guard and the MySQL pool. The real repos run
// against the mocked `query` / `transaction`, so route handlers and the repo
// round-trip are exercised without live infra (mirrors attachments.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import {
  listVersionsHandler,
  createVersionHandler,
  getVersionStateHandler,
  renameVersionHandler,
  deleteVersionHandler,
  restoreVersionHandler,
} from '../src/api/routes/versions.js'
import { requireDocRole } from '../src/api/guard.js'
import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { query, transaction } from '../src/db/pool.js'
import {
  gateSchema,
  restoreReconcile,
  SchemaIncompatibleError,
} from '../src/collab/versionRestore.js'
import { computeFinalState } from '../src/collab/persistence.js'
import { buildSchema, COLLAB_FIELD, SCHEMA_VERSION } from '../src/schema/index.js'
import { Node as PMNode } from 'prosemirror-model'
import { prosemirrorToYDoc, prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'

const schema = buildSchema()

interface MockRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  sent: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
  setHeader(k: string, v: string): void
  send(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    sent: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    send(b: unknown) {
      this.sent = b
      return this
    },
  }
}

function req(params: Record<string, string>, opts: { body?: unknown; query?: Record<string, unknown> } = {}) {
  return { uid: 'u_1', params, body: opts.body, query: opts.query ?? {} } as never
}

const adminGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', permission_epoch: 7 },
  role: 'admin',
} as never

/** Build a Yjs state from ProseMirror JSON (the snapshot format). */
function stateFromPM(pmJSON: unknown): Uint8Array {
  const node = PMNode.fromJSON(schema, pmJSON as Parameters<typeof PMNode.fromJSON>[1])
  const doc = prosemirrorToYDoc(node, COLLAB_FIELD)
  return Y.encodeStateAsUpdate(doc)
}

function para(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

/** Concatenate all paragraph texts of a doc's ProseMirror JSON. */
function paragraphTexts(pmJSON: unknown): string[] {
  const doc = pmJSON as { content?: Array<{ content?: Array<{ text?: string }> }> }
  return (doc.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? '').join(''))
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
  vi.mocked(transaction).mockReset()
})

// ── role gating: the min-role chosen per endpoint ─────────────────────────────
describe('role gating (server authority, §4.2 / §5.6)', () => {
  beforeEach(() => {
    // Block at the guard so each handler returns after the requireDocRole call;
    // we only assert which minRole it demanded.
    vi.mocked(requireDocRole).mockResolvedValue(null)
  })

  it('list requires reader', async () => {
    await listVersionsHandler(req({ docId: 'd_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
  })

  it('state preview requires reader', async () => {
    await getVersionStateHandler(req({ docId: 'd_1', versionId: '1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
  })

  it('snapshot requires writer', async () => {
    await createVersionHandler(req({ docId: 'd_1' }, { body: {} }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
  })

  it('rename requires writer', async () => {
    await renameVersionHandler(req({ docId: 'd_1', versionId: '1' }, { body: { name: 'x' } }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
  })

  it('delete requires admin (boss call)', async () => {
    await deleteVersionHandler(req({ docId: 'd_1', versionId: '1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('admin')
  })

  it('restore requires admin (boss call)', async () => {
    await restoreVersionHandler(req({ docId: 'd_1', versionId: '1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('admin')
  })
})

// ── schema forward-compat gate ────────────────────────────────────────────────
describe('gateSchema (forward-compat)', () => {
  it('rejects a target from a NEWER schema with version_schema_newer', () => {
    const g = gateSchema(SCHEMA_VERSION + 1)
    expect(g.ok).toBe(false)
    if (!g.ok) {
      expect(g.code).toBe('version_schema_newer')
      expect(g.status).toBe(409)
    }
  })

  it('accepts the current schema version', () => {
    expect(gateSchema(SCHEMA_VERSION).ok).toBe(true)
  })

  it('accepts an OLDER schema version (loadability checked at reconcile time)', () => {
    expect(gateSchema(1).ok).toBe(true)
  })
})

describe('restore endpoint schema gate', () => {
  it('returns 409 version_schema_newer when the target schema is newer', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    vi.spyOn(docVersionRepo, 'getStateById').mockResolvedValue({
      version: {
        id: 1,
        docId: 'd_1',
        documentName: 'octo:s1:f_default:d_1',
        kind: 2,
        name: '',
        compressed: 1,
        sizeBytes: 2,
        schemaVersion: SCHEMA_VERSION + 1,
        createdAt: new Date(0),
        createdBy: 'u_1',
      },
      state: stateFromPM({ type: 'doc', content: [para('A')] }),
    })
    const res = mockRes()
    await restoreVersionHandler(req({ docId: 'd_1', versionId: '1' }), res as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('version_schema_newer')
    vi.mocked(docVersionRepo.getStateById).mockRestore()
  })
})

// ── gzip round-trip through the repo (compress on write, decompress on read) ──
describe('docVersionRepo gzip round-trip (§4 state_blob)', () => {
  it('create gzips the state; getStateById gunzips back to identical bytes', async () => {
    const state = stateFromPM({ type: 'doc', content: [para('hello'), para('world')] })

    // Capture the blob the repo inserts under a faked transaction.
    let insertedBlob: Buffer | undefined
    vi.mocked(transaction).mockImplementation(async (fn: never) => {
      const tx = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO doc_version')) {
            insertedBlob = params![4] as Buffer
            return []
          }
          if (sql.includes('LAST_INSERT_ID')) return [{ id: 42 }]
          return []
        }),
      }
      return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
    })

    const id = await docVersionRepo.create({
      docId: 'd_1',
      documentName: 'octo:s1:f_default:d_1',
      kind: 2,
      state,
      schemaVersion: SCHEMA_VERSION,
      createdBy: 'u_1',
    })
    expect(id).toBe(42)
    expect(insertedBlob).toBeInstanceOf(Buffer)
    // Stored blob is gzip-compressed, not the raw state.
    expect(Uint8Array.from(insertedBlob!)).not.toEqual(state)

    // Feed that same blob back through getStateById's SELECT.
    vi.mocked(query).mockResolvedValue([
      {
        id: 42,
        doc_id: 'd_1',
        document_name: 'octo:s1:f_default:d_1',
        kind: 2,
        name: '',
        compressed: 1,
        size_bytes: state.length,
        schema_version: SCHEMA_VERSION,
        created_at: new Date(0),
        created_by: 'u_1',
        state_blob: insertedBlob,
      },
    ] as never)
    const got = await docVersionRepo.getStateById(42)
    expect(got!.state).toEqual(state)
    // And the decoded content round-trips.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, got!.state)
    expect(paragraphTexts(yDocToProsemirrorJSON(doc, COLLAB_FIELD))).toEqual(['hello', 'world'])
  })

  it('getStateById returns raw bytes unchanged when compressed=0', async () => {
    const state = stateFromPM({ type: 'doc', content: [para('plain')] })
    vi.mocked(query).mockResolvedValue([
      {
        id: 7,
        doc_id: 'd_1',
        document_name: 'octo:s1:f_default:d_1',
        kind: 2,
        name: '',
        compressed: 0,
        size_bytes: state.length,
        schema_version: SCHEMA_VERSION,
        created_at: new Date(0),
        created_by: 'u_1',
        state_blob: Buffer.from(state),
      },
    ] as never)
    const got = await docVersionRepo.getStateById(7)
    expect(got!.state).toEqual(state)
  })

  it('plain node:zlib gzip of the Yjs state round-trips losslessly', () => {
    const state = stateFromPM({ type: 'doc', content: [para('round')] })
    const blob = gzipSync(Buffer.from(state))
    expect(Uint8Array.from(gunzipSync(blob))).toEqual(state)
  })
})

// ── restore reconcile: forward, union-safe, deletions take effect ─────────────
describe('restoreReconcile — union-safe forward restore (the core, §4)', () => {
  it('reconciles target content into live and drops the live-only paragraph (no union reback)', () => {
    // Snapshot (target): [A, B]. Live continues forward: [A, B, C].
    const targetState = stateFromPM({ type: 'doc', content: [para('A'), para('B')] })

    // Build live as a FORWARD continuation of the target snapshot's doc, so live
    // ⊇ target in CRDT terms (mirrors a doc that kept evolving after the snapshot).
    const liveDoc = new Y.Doc()
    Y.applyUpdate(liveDoc, targetState)
    const liveFragment = liveDoc.get(COLLAB_FIELD, Y.XmlFragment)
    const liveJSON = PMNode.fromJSON(schema, { type: 'doc', content: [para('A'), para('B'), para('C')] })
    liveDoc.transact(() => {
      prosemirrorToYXmlFragment(liveJSON, liveFragment)
    })
    const liveState = Y.encodeStateAsUpdate(liveDoc)
    // Sanity: live really has the extra paragraph before restore.
    expect(paragraphTexts(yDocToProsemirrorJSON(liveDoc, COLLAB_FIELD))).toEqual(['A', 'B', 'C'])

    // Restore the target into the live state.
    const reconciled = restoreReconcile(liveState, targetState)

    // 1) Content now equals the TARGET — the live-only 'C' paragraph is gone
    //    (the deletion actually took effect; not a no-op).
    const out = new Y.Doc()
    Y.applyUpdate(out, reconciled)
    const texts = paragraphTexts(yDocToProsemirrorJSON(out, COLLAB_FIELD))
    expect(texts).toEqual(['A', 'B'])
    expect(texts).not.toContain('C')

    // 2) The write is on the union-safe direction: reconciled ⊇ liveState, so
    //    computeFinalState takes the diffUpdate bypass — NO union reback.
    const { finalState, usedUnion } = computeFinalState(liveState, reconciled)
    expect(usedUnion).toBe(false)
    expect(Uint8Array.from(finalState)).toEqual(reconciled)

    // 3) And the persisted result still has 'C' gone (proves no reback resurrects it).
    const persisted = new Y.Doc()
    Y.applyUpdate(persisted, new Uint8Array(finalState))
    expect(paragraphTexts(yDocToProsemirrorJSON(persisted, COLLAB_FIELD))).not.toContain('C')
  })

  it('restores onto a null (cold) live state by reconstructing the target content', () => {
    const targetState = stateFromPM({ type: 'doc', content: [para('only')] })
    const reconciled = restoreReconcile(null, targetState)
    const out = new Y.Doc()
    Y.applyUpdate(out, reconciled)
    expect(paragraphTexts(yDocToProsemirrorJSON(out, COLLAB_FIELD))).toEqual(['only'])
  })

  it('throws SchemaIncompatibleError when the target uses an unknown node type', () => {
    // Hand-build a Y.Doc whose fragment holds a node the current schema lacks.
    const bad = new Y.Doc()
    const frag = bad.get(COLLAB_FIELD, Y.XmlFragment)
    bad.transact(() => {
      frag.insert(0, [new Y.XmlElement('frobnicate')])
    })
    const badState = Y.encodeStateAsUpdate(bad)
    expect(() => restoreReconcile(null, badState)).toThrow(SchemaIncompatibleError)
  })
})
