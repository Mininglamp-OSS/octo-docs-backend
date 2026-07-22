import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { register: vi.fn(), getById: vi.fn() },
}))
vi.mock('../src/storage/objectStore.js', () => ({
  getObjectStore: () => ({
    presignPut: () => ({ uploadUrl: 'https://storage.test/upload', headers: {} }),
    presignGet: () => 'https://storage.test/read',
  }),
}))

import { svgUploadHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(code: number): MockRes
  json(body: unknown): MockRes
}

function response(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function request(svg: string, headers: Record<string, string> = {}) {
  const stream = Readable.from([Buffer.from(svg)]) as Readable & Record<string, unknown>
  stream.uid = 'u_writer'
  stream.spaceId = 's1'
  stream.params = { docId: 'd_1' }
  stream.headers = headers
  return stream as never
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'writer' } as never)
  vi.mocked(docAttachmentRepo.register).mockResolvedValue(undefined as never)
  vi.mocked(docAttachmentRepo.getById).mockImplementation(async (attachId: string) => ({
    attachId,
    docId: 'd_1',
    objectKey: `d_1/${attachId}/logo.svg`,
    mime: 'image/svg+xml',
    sizeBytes: 1,
    fileName: 'logo.svg',
    createdBy: 'u_writer',
    createdAt: new Date(0),
  }))
})

describe('POST sanitized SVG attachment', () => {
  it('uploads only sanitized bytes and registers the sanitized size', async () => {
    let uploaded = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      uploaded = Buffer.from(init?.body as Uint8Array).toString('utf8')
      return new Response(null, { status: 200 })
    }))
    const res = response()
    await svgUploadHandler(request(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0h1v1z"/></svg>',
      { 'x-file-name': encodeURIComponent('../../logo.svg') },
    ), res as never)

    expect(res.statusCode).toBe(201)
    expect(uploaded).toContain('<path')
    expect(uploaded).not.toMatch(/script|onload/i)
    expect(docAttachmentRepo.register).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd_1', mime: 'image/svg+xml', fileName: 'logo.svg', sizeBytes: Buffer.byteLength(uploaded),
    }))
  })

  it('rejects active XML without touching storage', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = response()
    await svgUploadHandler(request(
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    ), res as never)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_svg' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(docAttachmentRepo.register).not.toHaveBeenCalled()
  })
})
