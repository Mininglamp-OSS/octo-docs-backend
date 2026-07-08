import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { Node as PMNode } from 'prosemirror-model'
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'
import { COLLAB_FIELD } from '../src/schema/index.js'

// Offline unit test (mirrors versions.test.ts): mock the auth guard, the MySQL
// pool, and the live-document boundary. editDocBody's PURE core (anchor resolve,
// size gate, attachment collection) runs for real against the mocked live read.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/collab/liveDocWrite.js', () => ({
  readLiveForEdit: vi.fn(),
  commitLiveEdit: vi.fn(),
}))

import { getDocContentHandler, patchDocContentHandler } from '../src/api/routes/docContent.js'
import { requireDocRole } from '../src/api/guard.js'
import { transaction } from '../src/db/pool.js'
import { readLiveForEdit, commitLiveEdit } from '../src/collab/liveDocWrite.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../src/db/repos/docVersionRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { schema, encodeBaseVersion, parseBaseVersion } from '../src/collab/docBodyEdit.js'
import { config } from '../src/config/env.js'
import { SCHEMA_VERSION } from '../src/schema/index.js'

// ── mock req/res ────────────────────────────────────────────────────────────
interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}
function req(
  params: Record<string, string>,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  return { uid: 'u_1', spaceId: 's1', params, body: opts.body, headers: opts.headers ?? {} } as never
}

const writerGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', permission_epoch: 7 },
  role: 'writer',
} as never

function para(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}
function docNode(content: unknown[]): PMNode {
  return PMNode.fromJSON(schema, { type: 'doc', content } as Parameters<typeof PMNode.fromJSON>[1])
}
/** Build a live-read view (real PM doc + base SV + pre-edit state) from content. */
function liveView(content: unknown[]) {
  const doc = new Y.Doc()
  const frag = doc.get(COLLAB_FIELD, Y.XmlFragment)
  doc.transact(() => prosemirrorToYXmlFragment(docNode(content), frag))
  return {
    pmDoc: PMNode.fromJSON(schema, yDocToProsemirrorJSON(doc, COLLAB_FIELD) as Parameters<typeof PMNode.fromJSON>[1]),
    baseSV: Y.encodeStateVector(doc),
    preEditState: Y.encodeStateAsUpdate(doc),
  }
}

/** transaction() mock routing SQL to a metaRow; role recheck spied separately. */
function mockTx(metaRow: { owner_id: string; permission_epoch: number; status: number } | null) {
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM yjs_document')) return []
        if (sql.includes('FROM doc_meta')) return metaRow ? [metaRow] : []
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
}

const okMeta = { owner_id: 'u_1', permission_epoch: 7, status: 1 }

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(transaction).mockReset()
  vi.mocked(readLiveForEdit).mockReset()
  vi.mocked(commitLiveEdit).mockReset()
})

// ── role gating ───────────────────────────────────────────────────────────────
describe('role gating (server authority)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(null))

  it('GET /content requires reader', async () => {
    await getDocContentHandler(req({ docId: 'd_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('reader')
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
  })

  it('PATCH /content requires writer', async () => {
    await patchDocContentHandler(req({ docId: 'd_1' }, { body: {} }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('writer')
  })
})

// ── §7.20 GET /content ──────────────────────────────────────────────────────────
describe('GET /content — live body + base version', () => {
  it('returns the live PM JSON, schemaVersion, and matching base version', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const view = liveView([para('hello')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)

    const res = mockRes()
    await getDocContentHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { docId: string; doc: { type: string }; schemaVersion: number; baseVersion: string }
    expect(body.docId).toBe('d_1')
    expect(body.doc.type).toBe('doc')
    expect(body.schemaVersion).toBe(SCHEMA_VERSION)
    expect(body.baseVersion).toBe(encodeBaseVersion(view.baseSV))
  })
})

// ── §7.18 body validation (400) ─────────────────────────────────────────────────
describe('PATCH /content — body validation (400 invalid_body)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('missing baseVersion (no If-Match, no body.baseVersion) → 400', async () => {
    const res = mockRes()
    await patchDocContentHandler(
      req({ docId: 'd_1' }, { body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('x')] }] } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_body')
  })

  it('malformed ops (bad op shape) → 400', async () => {
    const res = mockRes()
    await patchDocContentHandler(
      req({ docId: 'd_1' }, { headers: { 'if-match': '"AQ=="' }, body: { ops: [{ type: 'insert' }] } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('invalid_body')
    // Never reached the live read on a shape failure.
    expect(readLiveForEdit).not.toHaveBeenCalled()
  })

  it('ops not an array → 400', async () => {
    const res = mockRes()
    await patchDocContentHandler(
      req({ docId: 'd_1' }, { headers: { 'if-match': '"AQ=="' }, body: { ops: 'nope' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
  })
})

// ── §7.8, 7.10 base-version guard (the compared value is the CLIENT token) ──────
describe('PATCH /content — base-version optimistic guard', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('§7.8: a client baseVersion != live SV → 412, no snapshot, no live write', async () => {
    const view = liveView([para('A'), para('B')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    // Client token is from a DIFFERENT doc (a human edited between GET and PATCH).
    const staleToken = encodeBaseVersion(Y.encodeStateVector(new Y.Doc()))
    const res = mockRes()
    await patchDocContentHandler(
      req(
        { docId: 'd_1' },
        {
          headers: { 'if-match': `"${staleToken}"` },
          body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }] },
        },
      ),
      res as never,
    )

    expect(res.statusCode).toBe(412)
    expect((res.body as { error: string }).error).toBe('base_version_stale')
    // Pre-flight fails before the snapshot tx and before the live write.
    expect(createSpy).not.toHaveBeenCalled()
    expect(commitLiveEdit).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('§7.10-11: a matching client baseVersion succeeds, snapshots the pre-edit state, and returns the new base version', async () => {
    const view = liveView([para('A'), para('B')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    const newSV = Y.encodeStateVector(new Y.Doc()) // opaque; asserted via encode
    vi.mocked(commitLiveEdit).mockResolvedValue({ newSV, bytes: 123 })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(99)
    mockTx(okMeta)

    const token = encodeBaseVersion(view.baseSV)
    const res = mockRes()
    await patchDocContentHandler(
      req(
        { docId: 'd_1' },
        {
          headers: { 'if-match': `"${token}"` },
          body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }] },
        },
      ),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    const body = res.body as { docId: string; bytes: number; baseVersion: string; newDocVersionSeq: number }
    expect(body).toEqual({ docId: 'd_1', bytes: 123, baseVersion: encodeBaseVersion(newSV), newDocVersionSeq: 99 })

    // The guard compared the CLIENT token: commitLiveEdit received exactly it.
    expect(vi.mocked(commitLiveEdit).mock.calls[0]![2]).toEqual(parseBaseVersion(token))

    // Exactly one safety snapshot, a KIND_RESTORE_MARKER of the PRE-edit state.
    expect(createSpy).toHaveBeenCalledTimes(1)
    const snap = createSpy.mock.calls[0]![1]
    expect(snap.kind).toBe(KIND_RESTORE_MARKER)
    expect(snap.name).toBe('Auto-safety before bot edit')
    expect(Uint8Array.from(snap.state)).toEqual(view.preEditState)
    createSpy.mockRestore()
  })
})

// ── §7.19 auth recheck under the lock (epoch / archived / role / not-found) ─────
describe('PATCH /content — under-lock recheck (server authority)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  function validReq() {
    const view = liveView([para('A'), para('B')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    return req(
      { docId: 'd_1' },
      {
        headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
        body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }] },
      },
    )
  }

  it('permission_epoch moved since authorization → 409 epoch_changed, no live write', async () => {
    mockTx({ owner_id: 'u_1', permission_epoch: 8, status: 1 }) // 8 != authorizedEpoch 7
    const r = validReq()
    const res = mockRes()
    await patchDocContentHandler(r, res as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('epoch_changed')
    expect(commitLiveEdit).not.toHaveBeenCalled()
  })

  it('archived doc → 409 conflict', async () => {
    mockTx({ owner_id: 'u_1', permission_epoch: 7, status: 2 })
    const res = mockRes()
    await patchDocContentHandler(validReq(), res as never)
    expect(res.statusCode).toBe(409)
    expect((res.body as { error: string }).error).toBe('conflict')
  })

  it('soft-deleted / missing doc row → 404 not_found', async () => {
    mockTx({ owner_id: 'u_1', permission_epoch: 7, status: 0 })
    const res = mockRes()
    await patchDocContentHandler(validReq(), res as never)
    expect(res.statusCode).toBe(404)
  })

  it('non-owner lacking writer under the lock → 403 forbidden', async () => {
    mockTx({ owner_id: 'someone_else', permission_epoch: 7, status: 1 })
    const roleSpy = vi.spyOn(docMemberRepo, 'getRoleTx').mockResolvedValue('reader')
    const res = mockRes()
    await patchDocContentHandler(validReq(), res as never)
    expect(res.statusCode).toBe(403)
    expect(commitLiveEdit).not.toHaveBeenCalled()
    roleSpy.mockRestore()
  })
})

// ── §7.13-14 boundary errors surfaced by the service (422) ──────────────────────
describe('PATCH /content — boundary errors (422)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('out-of-range path → 422 anchor_not_found, no snapshot, no live write', async () => {
    const view = liveView([para('A')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocContentHandler(
      req(
        { docId: 'd_1' },
        {
          headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
          body: { ops: [{ type: 'insert', at: { path: [9], position: 'after' }, content: [para('X')] }] },
        },
      ),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect((res.body as { error: string }).error).toBe('anchor_not_found')
    expect(createSpy).not.toHaveBeenCalled()
    expect(commitLiveEdit).not.toHaveBeenCalled()
    createSpy.mockRestore()
  })

  it('unknown node in content → 422 schema_incompatible', async () => {
    const view = liveView([para('A')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    mockTx(okMeta)
    const res = mockRes()
    await patchDocContentHandler(
      req(
        { docId: 'd_1' },
        {
          headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
          body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [{ type: 'frobnicate' }] }] },
        },
      ),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect((res.body as { error: string }).error).toBe('schema_incompatible')
  })
})

// ── §7.15-16 size gate (413, live-hydrated measure, before any mutation) ────────
describe('PATCH /content — size gate (413)', () => {
  it('a result whose live-hydrated encode exceeds maxDocBytes → 413, no snapshot, no live write', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const view = liveView([para('A'), para('B')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const originalCap = config.maxDocBytes
    config.maxDocBytes = 4 // any real edit encodes larger than 4 bytes
    try {
      const res = mockRes()
      await patchDocContentHandler(
        req(
          { docId: 'd_1' },
          {
            headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
            body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }] },
          },
        ),
        res as never,
      )
      expect(res.statusCode).toBe(413)
      expect((res.body as { error: string }).error).toBe('doc_too_large')
      expect(createSpy).not.toHaveBeenCalled()
      expect(commitLiveEdit).not.toHaveBeenCalled()
    } finally {
      config.maxDocBytes = originalCap
    }
    createSpy.mockRestore()
  })
})

// ── locked contract item 8: attachment reference validation (422) ──────────────
describe('PATCH /content — attachment reference validation', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('inserting an attachId that does not belong to the doc → 422 attachment_not_found', async () => {
    const view = liveView([para('A')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    // Attachment belongs to a DIFFERENT doc.
    const getSpy = vi.spyOn(docAttachmentRepo, 'getById').mockResolvedValue({
      attachId: 'a_x',
      docId: 'd_other',
      objectKey: 'k',
      mime: 'image/png',
      sizeBytes: 1,
      fileName: 'f',
      createdBy: 'u_1',
      createdAt: new Date(0),
    })
    mockTx(okMeta)

    const res = mockRes()
    await patchDocContentHandler(
      req(
        { docId: 'd_1' },
        {
          headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
          body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [{ type: 'image', attrs: { attachId: 'a_x' } }] }] },
        },
      ),
      res as never,
    )
    expect(res.statusCode).toBe(422)
    expect((res.body as { error: string }).error).toBe('attachment_not_found')
    expect(createSpy).not.toHaveBeenCalled()
    expect(commitLiveEdit).not.toHaveBeenCalled()
    getSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('an attachId that DOES belong to the doc passes the check and commits', async () => {
    const view = liveView([para('A')])
    vi.mocked(readLiveForEdit).mockResolvedValue(view)
    vi.mocked(commitLiveEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 50 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(101)
    const getSpy = vi.spyOn(docAttachmentRepo, 'getById').mockResolvedValue({
      attachId: 'a_ok',
      docId: 'd_1',
      objectKey: 'k',
      mime: 'image/png',
      sizeBytes: 1,
      fileName: 'f',
      createdBy: 'u_1',
      createdAt: new Date(0),
    })
    mockTx(okMeta)

    const res = mockRes()
    await patchDocContentHandler(
      req(
        { docId: 'd_1' },
        {
          headers: { 'if-match': `"${encodeBaseVersion(view.baseSV)}"` },
          body: { ops: [{ type: 'insert', at: { path: [0], position: 'after' }, content: [{ type: 'image', attrs: { attachId: 'a_ok' } }] }] },
        },
      ),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    expect(commitLiveEdit).toHaveBeenCalledTimes(1)
    getSpy.mockRestore()
    vi.mocked(docVersionRepo.createTx).mockRestore()
  })
})
