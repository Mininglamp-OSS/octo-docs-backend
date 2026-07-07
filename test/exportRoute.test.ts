import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the export route handler. Mocks the auth guard,
// persistence, conversion, attachment repo, object store, and pdfService
// so the route's requireDocRole call (space gating + role check) is
// exercised without live infra — regression coverage for the exact bug
// that shipped (wrong arity / broken space-gating on this route).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/collab/persistence.js', () => ({
  persistence: { fetch: vi.fn(async () => null) },
}))
vi.mock('../src/agent/conversion.js', () => ({
  yDocStateToProsemirrorJSON: vi.fn(() => ({ type: 'doc', content: [] })),
}))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { listByDoc: vi.fn(async () => []) },
}))
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: vi.fn(() => ({ presignGet: vi.fn(() => 'https://store.example.com/signed') })),
}))
vi.mock('../src/export/pdfService.js', () => ({
  renderPdf: vi.fn(async () => Buffer.from('%PDF-fake')),
  PdfQueueFullError: class PdfQueueFullError extends Error {},
  PdfTimeoutError: class PdfTimeoutError extends Error {},
  acquireSlot: vi.fn(async () => {}),
  releaseSlot: vi.fn(),
  maybeRecycleBrowser: vi.fn(async () => {}),
}))

import { exportPdfHandler } from '../src/api/routes/export.js'
import { requireDocRole } from '../src/api/guard.js'

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
  setHeader(k: string, v: string): void
  end(b?: Buffer): void
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 0,
    headers: {},
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      this.statusCode = this.statusCode || 200
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    end(b?: Buffer) {
      this.body = b
    },
  }
  return r
}

function req(params: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return {
    uid: 'u_1',
    spaceId: 's1',
    params,
    body: undefined,
    query: {},
    ...overrides,
  } as never
}

const mockedRequireDocRole = vi.mocked(requireDocRole)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('exportPdfHandler — route-level authz regression', () => {
  it('passes uid, docId, spaceId, and reader role to requireDocRole (5 args)', async () => {
    mockedRequireDocRole.mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'dn_1', title: 'Test' },
      role: 'reader',
    } as never)

    await exportPdfHandler(req({ docId: 'd_1' }), mockRes() as never)

    expect(mockedRequireDocRole).toHaveBeenCalledTimes(1)
    const args = mockedRequireDocRole.mock.calls[0]
    // [0]=res, [1]=uid, [2]=docId, [3]=spaceId, [4]=minRole
    expect(args).toHaveLength(5)
    expect(args[1]).toBe('u_1')
    expect(args[2]).toBe('d_1')
    expect(args[3]).toBe('s1')
    expect(args[4]).toBe('reader')
  })

  it('returns 404 when requireDocRole rejects a mismatched space / missing doc', async () => {
    // Faithfully model requireDocRole: on space mismatch / missing doc it writes
    // 404 to res and returns null. The handler must then return without
    // rendering. Asserting res.statusCode===404 actually covers the advertised
    // 404 behavior (not just the early return).
    mockedRequireDocRole.mockImplementation(async (res: never) => {
      ;(res as unknown as { status: (c: number) => { json: (b: unknown) => void } })
        .status(404)
        .json({ error: 'not_found' })
      return null
    })

    const res = mockRes()
    await exportPdfHandler(req({ docId: 'd_missing' }, { spaceId: 's_wrong' }), res as never)

    expect(mockedRequireDocRole).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(404)
    // The handler must not proceed to render PDF when guard fails (no PDF body).
    expect(res.headers['Content-Type']).toBeUndefined()
  })

  it('returns 403 when requireDocRole rejects insufficient role', async () => {
    mockedRequireDocRole.mockImplementation(async (res: never) => {
      ;(res as unknown as { status: (c: number) => { json: (b: unknown) => void } })
        .status(403)
        .json({ error: 'forbidden' })
      return null
    })

    const res = mockRes()
    await exportPdfHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(403)
    expect(res.headers['Content-Type']).toBeUndefined()
  })

  it('returns 200 with PDF when role is sufficient and space matches', async () => {
    mockedRequireDocRole.mockResolvedValue({
      meta: { doc_id: 'd_1', document_name: 'dn_1', title: 'Test Doc' },
      role: 'reader',
    } as never)

    const res = mockRes()
    await exportPdfHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/pdf')
    expect(res.headers['Content-Disposition']).toContain('Test Doc')
    expect(res.body).toBeDefined()
  })
})
