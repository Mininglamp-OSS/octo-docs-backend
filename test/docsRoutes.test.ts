import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: mock the auth guard and the MySQL pool. The route handler
// runs against the mocked guard, so the GET /:docId read-one path is exercised
// without live infra (mirrors attachments.test.ts / versions.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    create: vi.fn(async () => undefined),
    getByDocId: vi.fn(async () => null),
  },
}))
vi.mock('../src/util/ids.js', () => ({
  newDocId: vi.fn(() => 'd_fixed'),
}))

import { createDocHandler, getDocHandler } from '../src/api/routes/docs.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
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
}

function req(params: Record<string, string>) {
  return { uid: 'u_1', spaceId: 's1', params, body: undefined, query: {} } as never
}

/** A doc_meta row as the repo returns it (snake_case columns). */
const metaRow = {
  doc_id: 'd_1',
  document_name: 'octo:s1:f_default:d_1',
  title: 'My Doc',
  owner_id: 'u_owner',
  space_id: 's1',
  folder_id: 'f_default',
  doc_type: 'doc',
  status: 1,
  permission_epoch: 7,
  created_at: new Date(0),
  updated_at: new Date(1000),
  created_by: 'u_owner',
  updated_by: 'u_owner',
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
})

describe('GET /api/v1/docs/:docId — read one (§8.4)', () => {
  it('requires at least reader on the doc', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    await getDocHandler(req({ docId: 'd_1' }), mockRes() as never)
    // The space (4th arg) is sourced from req.spaceId; the minRole (5th arg) is 'reader'.
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('s1')
    expect(vi.mocked(requireDocRole).mock.calls[0]![4]).toBe('reader')
  })

  it('returns 200 with the camelCase doc shape for an authorized reader', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: metaRow, role: 'reader' } as never)

    const res = mockRes()
    await getDocHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      docId: 'd_1',
      documentName: 'octo:s1:f_default:d_1',
      title: 'My Doc',
      ownerId: 'u_owner',
      spaceId: 's1',
      folderId: 'f_default',
      docType: 'doc',
      role: 'reader',
      createdAt: new Date(0),
      updatedAt: new Date(1000),
      permissionEpoch: 7,
    })
    // snake_case columns are never leaked on the wire.
    const body = res.body as Record<string, unknown>
    expect(body).not.toHaveProperty('doc_id')
    expect(body).not.toHaveProperty('owner_id')
    expect(body).not.toHaveProperty('document_name')
  })

  it('surfaces the owner role string name straight from the guard', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: metaRow, role: 'admin' } as never)
    const res = mockRes()
    await getDocHandler(req({ docId: 'd_1' }), res as never)
    expect((res.body as { role: string }).role).toBe('admin')
  })

  it('omits permissionEpoch when the column is absent from meta', async () => {
    const { permission_epoch: _omit, ...without } = metaRow
    vi.mocked(requireDocRole).mockResolvedValue({ meta: without, role: 'reader' } as never)
    const res = mockRes()
    await getDocHandler(req({ docId: 'd_1' }), res as never)
    expect(res.body).not.toHaveProperty('permissionEpoch')
  })

  it('returns 404 for a missing/deleted doc (guard writes it and blocks)', async () => {
    // The real guard writes 404 and returns null; emulate that contract here.
    vi.mocked(requireDocRole).mockImplementation(async (res) => {
      ;(res as unknown as MockRes).status(404).json({ error: 'not_found' })
      return null
    })
    const res = mockRes()
    await getDocHandler(req({ docId: 'missing' }), res as never)
    expect(res.statusCode).toBe(404)
    expect((res.body as { error: string }).error).toBe('not_found')
  })

  it('returns 403 for a non-member (guard writes forbidden and blocks)', async () => {
    vi.mocked(requireDocRole).mockImplementation(async (res) => {
      ;(res as unknown as MockRes).status(403).json({ error: 'forbidden' })
      return null
    })
    const res = mockRes()
    await getDocHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: string }).error).toBe('forbidden')
  })
})

describe('POST /api/v1/docs — create key codec (XIN-83 hop-2 join 404)', () => {
  function postReq(body: Record<string, unknown>) {
    return { uid: 'u_1', params: {}, body, query: {} } as never
  }

  beforeEach(() => {
    vi.mocked(docMetaRepo.create).mockReset().mockResolvedValue(undefined as never)
    vi.mocked(docMetaRepo.getByDocId)
      .mockReset()
      .mockResolvedValue({ ...metaRow, doc_id: 'd_fixed' } as never)
  })

  it('mints the 5-segment :wb: key for a whiteboard (docType "board")', async () => {
    const res = mockRes()
    await createDocHandler(postReq({ spaceId: 's1', folderId: 'f_888', docType: 'board' }), res as never)

    expect(res.statusCode).toBe(201)
    const persisted = vi.mocked(docMetaRepo.create).mock.calls[0]![0]
    // Persistence/routing key MUST match what the browser joins with and what
    // onAuthenticate parses: octo:{space}:{folder}:wb:{board}, board === docId.
    expect(persisted.documentName).toBe('octo:s1:f_888:wb:d_fixed')
    expect(persisted.docType).toBe('board')
    expect((res.body as { documentName: string }).documentName).toBe('octo:s1:f_888:wb:d_fixed')
    expect((res.body as { docType: string }).docType).toBe('board')
  })

  it('mints the 4-segment document key for a rich-text doc (default docType)', async () => {
    const res = mockRes()
    await createDocHandler(postReq({ spaceId: 's1', folderId: 'f_888' }), res as never)

    expect(res.statusCode).toBe(201)
    const persisted = vi.mocked(docMetaRepo.create).mock.calls[0]![0]
    expect(persisted.documentName).toBe('octo:s1:f_888:d_fixed')
    expect(persisted.docType).toBe('doc')
  })

  it('defaults the folder segment to f_default when omitted', async () => {
    const res = mockRes()
    await createDocHandler(postReq({ spaceId: 's1', docType: 'board' }), res as never)

    const persisted = vi.mocked(docMetaRepo.create).mock.calls[0]![0]
    expect(persisted.documentName).toBe('octo:s1:f_default:wb:d_fixed')
  })

  it('rejects an illegal space segment with 400 (no row written)', async () => {
    const res = mockRes()
    await createDocHandler(postReq({ spaceId: 'bad space', docType: 'board' }), res as never)

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(docMetaRepo.create)).not.toHaveBeenCalled()
  })

  it('returns 400 when spaceId is missing', async () => {
    const res = mockRes()
    await createDocHandler(postReq({}), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('spaceId required')
  })
})
