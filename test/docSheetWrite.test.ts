import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { SHEET_YMAP_FIELD, SHEET_DIMS_FIELD, type SheetCell } from '../src/agent/sheetConversion.js'

// Offline unit test (mirrors docContent.test.ts): mock the auth guard, the MySQL
// pool, and the live-document boundary. editDocSheet's batch validation + the
// safety-snapshot orchestration run for real against the mocked live read.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({
  readLiveSheet: vi.fn(),
  commitLiveSheetEdit: vi.fn(),
}))

import { patchDocSheetHandler } from '../src/api/routes/docSheet.js'
import { requireDocRole } from '../src/api/guard.js'
import { transaction } from '../src/db/pool.js'
import { readLiveSheet, commitLiveSheetEdit } from '../src/collab/liveSheetWrite.js'
import { docVersionRepo, KIND_RESTORE_MARKER } from '../src/db/repos/docVersionRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { encodeBaseVersion, parseBaseVersion, BaseVersionStaleError } from '../src/collab/docBodyEdit.js'
import { config } from '../src/config/env.js'

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
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'sheet', permission_epoch: 7 },
  role: 'writer',
} as never

/** A live sheet ({state, baseSV}) built from raw cell + dims maps. */
function liveSheet(
  cells: Record<string, unknown> = {},
  dims: Record<string, number> = {},
) {
  const doc = new Y.Doc()
  const cellMap = doc.getMap<unknown>(SHEET_YMAP_FIELD)
  const dimMap = doc.getMap<number>(SHEET_DIMS_FIELD)
  doc.transact(() => {
    for (const [k, v] of Object.entries(cells)) cellMap.set(k, v)
    for (const [k, v] of Object.entries(dims)) dimMap.set(k, v)
  })
  return { state: Y.encodeStateAsUpdate(doc), baseSV: Y.encodeStateVector(doc) }
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
/** A body whose baseVersion matches the given live view's state vector. */
function bodyFor(view: { baseSV: Uint8Array }, cells: Record<string, SheetCell | null>) {
  return { baseVersion: encodeBaseVersion(view.baseSV), cells }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(transaction).mockReset()
  vi.mocked(readLiveSheet).mockReset()
  vi.mocked(commitLiveSheetEdit).mockReset()
})

// ── role gating ───────────────────────────────────────────────────────────────
describe('role gating (server authority)', () => {
  it('PATCH /sheet requires writer in the caller space', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await patchDocSheetHandler(req({ docId: 'd_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('writer')
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
    // A blocked guard short-circuits before touching the live document.
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── doc_type gate (gate b: sheet allowed here, non-sheet rejected) ──────────────
describe('doc_type gate', () => {
  it('rejects a non-sheet target with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc', permission_epoch: 1 },
      role: 'writer',
    } as never)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: { baseVersion: 'x', cells: { 'default!0:0': { v: 1 } } } }),
      res as never,
    )

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── request-shape validation ────────────────────────────────────────────────────
describe('request shape', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('400 when baseVersion (If-Match / body) is absent', async () => {
    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { cells: { 'default!0:0': { v: 1 } } } }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_body' })
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })

  it('400 when cells is missing, empty, or not an object', async () => {
    for (const cells of [undefined, {}, [], 'x']) {
      const res = mockRes()
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { baseVersion: 'v', cells } }), res as never)
      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_body' })
    }
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })

  it('accepts the base version from the If-Match header', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 12 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(5)
    mockTx(okMeta)

    const token = encodeBaseVersion(view.baseSV)
    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: { cells: { 'default!0:0': { v: 1 } } }, headers: { 'if-match': `"${token}"` } }),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    // The guard compared the CLIENT token, quotes stripped.
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![2]).toEqual(parseBaseVersion(token))
  })

  it('413 too_many_cells when the batch exceeds the cap', async () => {
    const original = config.sheetWrite.maxCells
    config.sheetWrite.maxCells = 2
    try {
      const res = mockRes()
      const cells = { 'default!0:0': { v: 1 }, 'default!0:1': { v: 2 }, 'default!0:2': { v: 3 } }
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { baseVersion: 'v', cells } }), res as never)
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'too_many_cells' })
      expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
    } finally {
      config.sheetWrite.maxCells = original
    }
  })

  it('413 cell_too_large when a single cell payload exceeds the cap', async () => {
    const original = config.sheetWrite.maxCellContentBytes
    config.sheetWrite.maxCellContentBytes = 20
    try {
      const res = mockRes()
      const cells = { 'default!0:0': { v: 'x'.repeat(100) } }
      await patchDocSheetHandler(req({ docId: 'd_1' }, { body: { baseVersion: 'v', cells } }), res as never)
      expect(res.statusCode).toBe(413)
      expect(res.body).toEqual({ error: 'cell_too_large' })
    } finally {
      config.sheetWrite.maxCellContentBytes = original
    }
  })
})

// ── happy path: batch write + safety snapshot ────────────────────────────────────
describe('PATCH /sheet — batch write', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('writes a batch, records a KIND_RESTORE_MARKER safety snapshot, returns the new base version', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'old' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const newSV = Y.encodeStateVector((() => { const d = new Y.Doc(); d.getMap('x').set('a', 1); return d })())
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV, bytes: 321 })
    const createSpy = vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(42)
    mockTx(okMeta)

    const res = mockRes()
    const cells = { 'default!0:0': { v: 'new', f: '=1', s: { bold: true } }, 'default!1:1': { v: 7 } }
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, cells) }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { docId: string; bytes: number; baseVersion: string; newDocVersionSeq: number }
    expect(body.docId).toBe('d_1')
    expect(body.bytes).toBe(321)
    expect(body.baseVersion).toBe(encodeBaseVersion(newSV))
    expect(body.newDocVersionSeq).toBe(42)

    // Safety snapshot is a KIND_RESTORE_MARKER of the PRE-edit state.
    expect(createSpy).toHaveBeenCalledTimes(1)
    const snap = createSpy.mock.calls[0]![1]
    expect(snap.kind).toBe(KIND_RESTORE_MARKER)
    expect(snap.state).toBe(view.state)
    // commitLiveSheetEdit got the acting uid + the whole batch.
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![1]).toBe('u_1')
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![3]).toEqual(cells)
  })

  it('supports deleting a cell with a null value', async () => {
    const view = liveSheet({ 'default!0:0': { v: 'gone' } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    vi.mocked(commitLiveSheetEdit).mockResolvedValue({ newSV: Y.encodeStateVector(new Y.Doc()), bytes: 10 })
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(1)
    mockTx(okMeta)

    const res = mockRes()
    const cells = { 'default!0:0': null }
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, cells) }), res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(commitLiveSheetEdit).mock.calls[0]![3]).toEqual(cells)
  })
})

// ── optimistic concurrency + safety contract ─────────────────────────────────────
describe('optimistic concurrency & safety contract', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('412 base_version_stale in the pre-flight when the token no longer matches', async () => {
    const view = liveSheet({ 'default!0:0': { v: 1 } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    // A stale token (empty-doc SV) != the live view's SV.
    const stale = encodeBaseVersion(Y.encodeStateVector(new Y.Doc()))
    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: { baseVersion: stale, cells: { 'default!0:0': { v: 2 } } } }),
      res as never,
    )

    expect(res.statusCode).toBe(412)
    expect(res.body).toEqual({ error: 'base_version_stale' })
    // No snapshot row and no live write on a pre-flight conflict.
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('412 base_version_stale from the live guard compensates the safety snapshot', async () => {
    const view = liveSheet({ 'default!0:0': { v: 1 } })
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    // Pre-flight passes; the authoritative in-transact guard rejects a drift.
    vi.mocked(commitLiveSheetEdit).mockRejectedValue(new BaseVersionStaleError())
    vi.spyOn(docVersionRepo, 'createTx').mockResolvedValue(77)
    const delSpy = vi.spyOn(docVersionRepo, 'deleteById').mockResolvedValue(undefined)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 2 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(412)
    expect(res.body).toEqual({ error: 'base_version_stale' })
    // The orphan safety snapshot is compensating-deleted.
    expect(delSpy).toHaveBeenCalledWith(77)
  })

  it('409 epoch_changed when permission_epoch moved under the lock', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx({ owner_id: 'u_1', permission_epoch: 8, status: 1 }) // 8 != authorizedEpoch 7

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 1 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'epoch_changed' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('403 forbidden when the re-checked role is below writer', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx({ owner_id: 'someone_else', permission_epoch: 7, status: 1 })
    vi.spyOn(docMemberRepo, 'getRoleTx').mockResolvedValue('reader')

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 1 } }) }),
      res as never,
    )

    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('404 not_found when the row is missing/deleted under the lock', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx({ owner_id: 'u_1', permission_epoch: 7, status: 0 })

    const res = mockRes()
    await patchDocSheetHandler(req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { v: 1 } }) }), res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })
})

// ── cell contract (fail-closed) ──────────────────────────────────────────────────
describe('cell contract validation', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('422 sheet_cell_invalid on a cell with an unexpected field, before any lock/write', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    const createSpy = vi.spyOn(docVersionRepo, 'createTx')
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'default!0:0': { evil: 1 } as never }) }),
      res as never,
    )

    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
    expect(createSpy).not.toHaveBeenCalled()
    expect(vi.mocked(commitLiveSheetEdit)).not.toHaveBeenCalled()
  })

  it('422 sheet_cell_invalid on a delete keyed by a malformed cell key', async () => {
    const view = liveSheet()
    vi.mocked(readLiveSheet).mockResolvedValue(view)
    mockTx(okMeta)

    const res = mockRes()
    await patchDocSheetHandler(
      req({ docId: 'd_1' }, { body: bodyFor(view, { 'not a cell key': null }) }),
      res as never,
    )

    expect(res.statusCode).toBe(422)
    expect(res.body).toEqual({ error: 'sheet_cell_invalid' })
  })
})
