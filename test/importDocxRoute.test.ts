import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response } from 'express'

// Offline route test: mock the auth guard, the media/parse layer, and the
// object-store/repo deps so importDocxHandler runs without live infra
// (mirrors docsRoutes.test.ts / attachments.test.ts). We assert the handler
// maps guard/body/parse outcomes to the right status codes.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/import/docx/index.js', () => ({
  importDocxWithMedia: vi.fn(),
}))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { register: vi.fn(async () => undefined) },
}))
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: vi.fn(() => ({ presignPut: () => ({ uploadUrl: 'http://x', headers: {} }) })),
}))
vi.mock('../src/import/docx/importQueue.js', () => ({
  acquireDocxImportSlot: vi.fn(async () => undefined),
  releaseDocxImportSlot: vi.fn(),
  DocxImportBusyError: class DocxImportBusyError extends Error {},
}))

import { importDocxHandler } from '../src/api/routes/import.js'
import { requireDocRole } from '../src/api/guard.js'
import { importDocxWithMedia } from '../src/import/docx/index.js'
import { DocxUnsafeError } from '../src/import/docx/extract.js'
import {
  acquireDocxImportSlot,
  releaseDocxImportSlot,
  DocxImportBusyError,
} from '../src/import/docx/importQueue.js'

const guard = vi.mocked(requireDocRole)
const parse = vi.mocked(importDocxWithMedia)
const acquire = vi.mocked(acquireDocxImportSlot)
const release = vi.mocked(releaseDocxImportSlot)

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
/** Build a minimal Request; only the fields importDocxHandler reads are set. */
function req(body: unknown): Request {
  return { uid: 'u1', spaceId: 's1', params: { docId: 'd1' }, body } as unknown as Request
}
/** Read a JSON body field without an `any` cast. */
function field(res: MockRes, key: string): unknown {
  return (res.body as Record<string, unknown> | undefined)?.[key]
}
async function run(res: MockRes, body: unknown): Promise<void> {
  await importDocxHandler(req(body), res as unknown as Response)
}

// requireDocRole resolves to a guard object (writer allowed) or undefined.
const guardOk = { meta: { doc_id: 'd1' } } as unknown as Awaited<ReturnType<typeof requireDocRole>>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('importDocxHandler — status mapping', () => {
  it('400 when the doc id param is not a plain string (type-confusion guard)', async () => {
    const res = mockRes()
    // A crafted request making params.docId an array must be rejected before the guard.
    await importDocxHandler(
      { uid: 'u1', spaceId: 's1', params: { docId: ['a', 'b'] }, body: Buffer.from('PK') } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('invalid_doc_id')
    expect(guard).not.toHaveBeenCalled()
  })

  it('stops at the guard (writer default-deny) without parsing', async () => {
    // requireDocRole returns falsy after already writing its own 403/404.
    guard.mockResolvedValue(undefined as unknown as typeof guardOk)
    const res = mockRes()
    await run(res, Buffer.from('PK'))
    expect(parse).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(0) // guard owns the response
  })

  it('400 when the body is not a Buffer (wrong/absent content-type)', async () => {
    guard.mockResolvedValue(guardOk)
    const res = mockRes()
    await run(res, {})
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('invalid_body')
  })

  it('400 on an empty upload', async () => {
    guard.mockResolvedValue(guardOk)
    const res = mockRes()
    await run(res, Buffer.alloc(0))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('empty_upload')
  })

  it('maps a corrupt/not-a-zip DocxUnsafeError to 400', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new DocxUnsafeError('bad magic', 'not-a-zip'))
    const res = mockRes()
    await run(res, Buffer.from('not a zip'))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('import_unsafe')
    expect(field(res, 'reason')).toBe('not-a-zip')
  })

  it('maps an oversize/bomb DocxUnsafeError to 413', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new DocxUnsafeError('too big', 'total-too-large'))
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(413)
    expect(field(res, 'error')).toBe('import_unsafe')
  })

  it('maps a generic parse failure to 422 without leaking the error', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new Error('boom at /secret/path'))
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(422)
    expect(field(res, 'error')).toBe('import_failed')
    expect(JSON.stringify(res.body)).not.toContain('/secret/path')
  })

  it('maps a parse-deadline timeout DocxUnsafeError to 400', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockRejectedValue(new DocxUnsafeError('parse budget spent', 'timeout'))
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(400)
    expect(field(res, 'error')).toBe('import_unsafe')
    expect(field(res, 'reason')).toBe('timeout')
  })

  it('returns 503 when the import queue is saturated, without parsing', async () => {
    guard.mockResolvedValue(guardOk)
    acquire.mockRejectedValueOnce(new DocxImportBusyError())
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(503)
    expect(field(res, 'error')).toBe('import_busy')
    expect(parse).not.toHaveBeenCalled()
  })

  it('always releases the import slot (success and failure)', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockResolvedValue({ doc: { type: 'doc', content: [] }, warnings: [] })
    await run(mockRes(), Buffer.from('PKzip'))
    parse.mockRejectedValue(new Error('boom'))
    await run(mockRes(), Buffer.from('PKzip'))
    // Once per handled request that acquired a slot (both above).
    expect(release.mock.calls.length).toBe(2)
  })

  it('returns 200 with the parsed doc + warnings on success', async () => {
    guard.mockResolvedValue(guardOk)
    parse.mockResolvedValue({ doc: { type: 'doc', content: [] }, warnings: ['w1'] })
    const res = mockRes()
    await run(res, Buffer.from('PKzip'))
    expect(res.statusCode).toBe(200)
    expect((field(res, 'doc') as { type: string }).type).toBe('doc')
    expect(field(res, 'warnings')).toEqual(['w1'])
  })
})
