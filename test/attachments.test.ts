import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit test: mock the auth guard and the MySQL pool. The real
// docAttachmentRepo runs against the mocked `query`, so the repo round-trip and
// the route handlers are exercised without live infra.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { presignHandler, readHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { query } from '../src/db/pool.js'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'
import { verifySignedUrl } from '../src/storage/objectStore.js'
import { requireSafeSigningSecret } from '../src/config/env.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
  return res
}

function req(params: Record<string, string>, body?: unknown) {
  return { uid: 'u_writer', params, body } as never
}

const writerGuard = { meta: { doc_id: 'd_1' }, role: 'writer' } as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
})

describe('POST presign validation (§3.5 step 1)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('rejects a disallowed mime with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'x.bin', mime: 'application/octet-stream', sizeBytes: 10 }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_not_allowed')
  })

  it('rejects image/svg+xml even though it matches the image/ prefix (XSS)', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'evil.svg', mime: 'image/svg+xml', sizeBytes: 256 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_blocked')
  })

  it('rejects image/svg+xml even with a charset parameter appended', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'evil.svg', mime: 'image/svg+xml; charset=utf-8', sizeBytes: 256 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_blocked')
  })

  it('rejects oversize sizeBytes with 400', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'big.png', mime: 'image/png', sizeBytes: 999 * 1024 * 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('size_too_large')
  })

  it('rejects a non-positive / non-number sizeBytes with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'a.png', mime: 'image/png', sizeBytes: 0 }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty fileName with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: '', mime: 'image/png', sizeBytes: 10 }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('sanitizes a path-traversal fileName so the object key cannot escape', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: '../../etc/passwd', mime: 'image/png', sizeBytes: 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { objectKey: string; uploadUrl: string; attachId: string }
    expect(body.objectKey).not.toContain('..')
    expect(body.objectKey).not.toContain('/etc/')
    expect(body.objectKey).toBe(`d_1/${body.attachId}/passwd`)
    // The minted PUT url is a real, verifiable signature (not a stub).
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
  })

  it('registers the attachment and returns a real presigned PUT url', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'photo.png', mime: 'image/png', sizeBytes: 2048 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { uploadUrl: string; expiresInSec: number }
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
    expect(body.expiresInSec).toBeGreaterThan(0)
    // doc_attachment row inserted via the repo's INSERT.
    const insertCall = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_attachment'))
    expect(insertCall).toBeTruthy()
  })
})

describe('GET read endpoint (§3.5 step 5)', () => {
  it('404s when the attachment belongs to a different doc', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never)
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_x', doc_id: 'd_OTHER', object_key: 'd_OTHER/att_x/a.png', mime: 'image/png', size_bytes: 1, created_by: 'u', created_at: new Date(0) },
    ] as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_x' }), res as never)
    expect(res.statusCode).toBe(404)
  })

  it('returns a freshly signed GET url for an owned attachment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never)
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_1', doc_id: 'd_1', object_key: 'd_1/att_1/photo.png', mime: 'image/png', size_bytes: 2048, created_by: 'u', created_at: new Date(0) },
    ] as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { url: string; attachId: string }
    expect(body.attachId).toBe('att_1')
    expect(verifySignedUrl(body.url).valid).toBe(true)
  })
})

describe('widened MIME accept/deny + size tiers (§3.5 ⑯)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  const ok = async (mime: string, sizeBytes = 1024) => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'f', mime, sizeBytes }), res as never)
    return res
  }

  it('accepts the widened non-image types (pdf / docx / xlsx / zip / text-plain)', async () => {
    for (const mime of [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
      'text/plain',
      'text/plain; charset=utf-8',
    ]) {
      const res = await ok(mime)
      expect(res.statusCode, mime).toBe(200)
    }
  })

  it('blocks dangerous types via the denylist (html / javascript / executable)', async () => {
    for (const mime of ['text/html', 'application/xhtml+xml', 'application/javascript', 'application/x-msdownload']) {
      const res = await ok(mime)
      expect(res.statusCode, mime).toBe(400)
      expect((res.body as { error: string }).error, mime).toBe('mime_blocked')
    }
  })

  it('exact-matches text/plain so forged text/plaintext is rejected (S5)', async () => {
    for (const mime of ['text/plaintext', 'text/plain-x', 'text/plainsomething']) {
      const res = await ok(mime)
      expect(res.statusCode, mime).toBe(400)
      expect((res.body as { error: string }).error, mime).toBe('mime_not_allowed')
    }
  })

  it('applies the image tier (10MB): 11MB image/png is rejected', async () => {
    const res = await ok('image/png', 11 * 1024 * 1024)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('size_too_large')
  })

  it('applies the file tier (50MB): 11MB pdf accepted, 51MB pdf rejected', async () => {
    const accepted = await ok('application/pdf', 11 * 1024 * 1024)
    expect(accepted.statusCode).toBe(200)
    const rejected = await ok('application/pdf', 51 * 1024 * 1024)
    expect(rejected.statusCode).toBe(400)
    expect((rejected.body as { error: string }).error).toBe('size_too_large')
  })

  it('persists the sanitized file_name on register', async () => {
    const res = await ok('application/pdf', 2048)
    expect(res.statusCode).toBe(200)
    const insert = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_attachment'))
    expect(insert).toBeTruthy()
    // (attach_id, doc_id, object_key, mime, size_bytes, file_name, created_by)
    expect((insert![1] as unknown[])[5]).toBe('f')
  })
})

describe('read-time Content-Disposition (§3.5 ⑯ A2)', () => {
  const rowFor = (mime: string, fileName: string) => [
    { attach_id: 'att_1', doc_id: 'd_1', object_key: `d_1/att_1/${fileName}`, mime, size_bytes: 2048, file_name: fileName, created_by: 'u', created_at: new Date(0) },
  ]

  beforeEach(() =>
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never),
  )

  it('forces attachment download for non-inline types and echoes fileName', async () => {
    vi.mocked(query).mockResolvedValue(rowFor('application/zip', 'report.zip') as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { url: string; fileName: string }
    expect(body.fileName).toBe('report.zip')
    const disp = new URL(body.url).searchParams.get('response-content-disposition')
    expect(disp).toBe('attachment; filename="report.zip"')
    // Disposition is bound into the signature — the URL still verifies.
    expect(verifySignedUrl(body.url).valid).toBe(true)
  })

  it('leaves inline types (image/pdf) without a forced-download disposition', async () => {
    for (const mime of ['image/png', 'application/pdf']) {
      vi.mocked(query).mockResolvedValue(rowFor(mime, 'a.bin') as never)
      const res = mockRes()
      await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
      const url = new URL((res.body as { url: string }).url)
      expect(url.searchParams.get('response-content-disposition'), mime).toBeNull()
    }
  })
})

describe('docAttachmentRepo (§3.4)', () => {
  it('register issues an INSERT with the mapped columns', async () => {
    await docAttachmentRepo.register({
      attachId: 'att_1',
      docId: 'd_1',
      objectKey: 'd_1/att_1/photo.png',
      mime: 'image/png',
      sizeBytes: 2048,
      fileName: 'photo.png',
      createdBy: 'u_1',
    })
    const call = vi.mocked(query).mock.calls[0]!
    expect(String(call[0])).toContain('INSERT INTO doc_attachment')
    expect(String(call[0])).toContain('file_name')
    expect(call[1]).toEqual(['att_1', 'd_1', 'd_1/att_1/photo.png', 'image/png', 2048, 'photo.png', 'u_1'])
  })

  it('getById maps snake_case columns to camelCase', async () => {
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_1', doc_id: 'd_1', object_key: 'd_1/att_1/p.png', mime: 'image/png', size_bytes: 2048, file_name: 'p.png', created_by: 'u_1', created_at: new Date(0) },
    ] as never)
    const got = await docAttachmentRepo.getById('att_1')
    expect(got).toEqual({
      attachId: 'att_1',
      docId: 'd_1',
      objectKey: 'd_1/att_1/p.png',
      mime: 'image/png',
      sizeBytes: 2048,
      fileName: 'p.png',
      createdBy: 'u_1',
      createdAt: new Date(0),
    })
  })

  it('getById returns null when no row exists', async () => {
    vi.mocked(query).mockResolvedValue([] as never)
    expect(await docAttachmentRepo.getById('nope')).toBeNull()
  })
})

describe('schema image node (§7.1 / §9.2)', () => {
  it('exposes SCHEMA_VERSION as a number', () => {
    expect(typeof SCHEMA_VERSION).toBe('number')
  })

  it('includes the image node so server-side conversion preserves images', () => {
    const schema = buildSchema()
    expect(schema.nodes.image).toBeDefined()
    const attrs = schema.nodes.image!.spec.attrs ?? {}
    expect(Object.keys(attrs)).toEqual(
      expect.arrayContaining(['attachId', 'src', 'alt', 'title', 'width', 'align']),
    )
  })
})

describe('signing-secret fail-fast (§3.5 / production)', () => {
  const DEV_DEFAULT = 'dev-only-change-me'
  const prevNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
  })

  it('throws when the dev default secret is used in production', () => {
    process.env.NODE_ENV = 'production'
    expect(() => requireSafeSigningSecret(DEV_DEFAULT)).toThrow()
  })

  it('accepts a real override in production', () => {
    process.env.NODE_ENV = 'production'
    expect(requireSafeSigningSecret('a-real-prod-secret')).toBe('a-real-prod-secret')
  })

  it('keeps the dev default working outside production', () => {
    process.env.NODE_ENV = 'test'
    expect(requireSafeSigningSecret(DEV_DEFAULT)).toBe(DEV_DEFAULT)
  })
})
