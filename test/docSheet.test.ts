import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { SHEET_YMAP_FIELD, SHEET_DIMS_FIELD, type SheetCell } from '../src/agent/sheetConversion.js'

// Offline unit test (mirrors docContent.test.ts): mock the auth guard and the
// live-document boundary. The route's decode + payload-guard runs for real
// against a mocked live read built from a genuine Y.Doc.
vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/collab/liveSheetWrite.js', () => ({ readLiveSheet: vi.fn() }))

import { getDocSheetHandler } from '../src/api/routes/docSheet.js'
import { requireDocRole } from '../src/api/guard.js'
import { readLiveSheet } from '../src/collab/liveSheetWrite.js'
import { encodeBaseVersion } from '../src/collab/docBodyEdit.js'
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
function req(params: Record<string, string>) {
  return { uid: 'u_1', spaceId: 's1', params, headers: {} } as never
}

const sheetGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'sheet', permission_epoch: 3 },
  role: 'reader',
} as never

/** Build a live-read view ({state, baseSV}) from raw cell + dims maps. */
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

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(readLiveSheet).mockReset()
})

// ── role gating ───────────────────────────────────────────────────────────────
describe('role gating (server authority)', () => {
  it('GET /sheet requires reader in the caller space', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await getDocSheetHandler(req({ docId: 'd_1' }), mockRes() as never)
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('reader')
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
    // A blocked guard short-circuits before touching the live document.
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── GET /sheet ────────────────────────────────────────────────────────────────
describe('GET /sheet — live cells + dims + base version', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(sheetGuard))

  it('returns cells, dims, docId, and the matching base version', async () => {
    const view = liveSheet(
      { 'default!0:0': { v: 'A1' }, 'default!1:2': { v: 42, f: '=1+41' } },
      { c0: 120, r3: 40 },
    )
    vi.mocked(readLiveSheet).mockResolvedValue(view)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as {
      docId: string
      sheetCells: Record<string, SheetCell>
      sheetDims: Record<string, number>
      baseVersion: string
    }
    expect(body.docId).toBe('d_1')
    expect(body.sheetCells).toEqual({ 'default!0:0': { v: 'A1' }, 'default!1:2': { v: 42, f: '=1+41' } })
    expect(body.sheetDims).toEqual({ c0: 120, r3: 40 })
    expect(body.baseVersion).toBe(encodeBaseVersion(view.baseSV))
    // Reads the live doc by its canonical name.
    expect(vi.mocked(readLiveSheet).mock.calls[0]![0]).toBe('octo:s1:f_default:d_1')
  })

  it('returns empty maps for a blank sheet', async () => {
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({}, {}))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { sheetCells: object; sheetDims: object }
    expect(body.sheetCells).toEqual({})
    expect(body.sheetDims).toEqual({})
  })

  it('fails closed with 409 when a cell violates the {v,f,s} contract', async () => {
    // A hostile cell carrying an unexpected field must not be serialized to the
    // client — decodeSheetSnapshot throws SheetSnapshotInvalidError -> 409.
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({ 'default!0:0': { evil: 1 } }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'sheet_snapshot_invalid' })
  })

  it('returns 500 when the live read fails', async () => {
    vi.mocked(readLiveSheet).mockRejectedValue(new Error('boom'))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: 'internal_error' })
  })
})

// ── non-sheet doc_type ──────────────────────────────────────────────────────────
describe('doc_type gate', () => {
  it('rejects a non-sheet target with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc', permission_epoch: 1 },
      role: 'reader',
    } as never)

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
    // The doc_type gate short-circuits before any live read.
    expect(vi.mocked(readLiveSheet)).not.toHaveBeenCalled()
  })
})

// ── large-sheet guard (1MB) ─────────────────────────────────────────────────────
describe('large-sheet read guard', () => {
  const original = config.sheetRead.maxCellBytes
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(sheetGuard))
  afterEach(() => {
    config.sheetRead.maxCellBytes = original
  })

  it('returns 413 sheet_too_large when the decoded payload exceeds the cap', async () => {
    // Lower the cap so the test stays fast and deterministic instead of building
    // a real >1MB grid; the guard logic is identical.
    config.sheetRead.maxCellBytes = 200
    const cells: Record<string, SheetCell> = {}
    for (let r = 0; r < 40; r++) cells[`default!${r}:0`] = { v: `row-${r}-value` }
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet(cells))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(413)
    const body = res.body as { error: string; bytes: number; limit: number }
    expect(body.error).toBe('sheet_too_large')
    expect(body.limit).toBe(200)
    expect(body.bytes).toBeGreaterThan(200)
  })

  it('serves a sheet that sits just under the cap', async () => {
    config.sheetRead.maxCellBytes = 1024 * 1024
    vi.mocked(readLiveSheet).mockResolvedValue(liveSheet({ 'default!0:0': { v: 'ok' } }))

    const res = mockRes()
    await getDocSheetHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
  })
})
