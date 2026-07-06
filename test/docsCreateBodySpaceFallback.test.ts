import { describe, it, expect, vi, beforeEach } from 'vitest'

// P3 close-out: the create handler must source the space *solely* from the
// enforced X-Space-Id header (req.spaceId, set by spaceContextMiddleware). The
// transitional body.spaceId fallback (P1) is removed here, so a request body's
// spaceId is fully ignored and never rescues a request that lacks the header.
// We mock docMetaRepo and drive POST '/' off the docsRouter stack (mirrors
// docsSpaceIsolation.test.ts / membersRoutes.test.ts).
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    listForUser: vi.fn(async () => ({ total: 0, items: [] })),
    create: vi.fn(async () => {}),
    getByDocId: vi.fn(async () => ({ title: 'T', created_at: new Date(0) })),
  },
}))
vi.mock('../src/permission/epoch.js', () => ({
  refreshAndPublish: vi.fn(async () => {}),
}))

import { docsRouter } from '../src/api/routes/docs.js'
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

// Resolve the collection-path handler registered on docsRouter.
function collectionHandler(method: 'get' | 'post') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (docsRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/' && route.methods?.[method]) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error(`${method} / handler not found`)
}

beforeEach(() => {
  vi.mocked(docMetaRepo.listForUser).mockClear()
  vi.mocked(docMetaRepo.create).mockClear()
  vi.mocked(docMetaRepo.getByDocId).mockClear()
})

describe('POST /api/v1/docs — body.spaceId fallback is removed (P3)', () => {
  it('creates in the header space even when the body carries a different spaceId', async () => {
    const res = mockRes()
    const req = {
      uid: 'u_owner',
      spaceId: 's_header',
      body: { spaceId: 's_body_attacker', folderId: 'f_x', title: 'Hi', docType: 'doc' },
    } as never
    await collectionHandler('post')(req, res as never)

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(docMetaRepo.create)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(docMetaRepo.create).mock.calls[0]![0]
    expect(input.spaceId).toBe('s_header')
    expect(input.documentName.split(':')[1]).toBe('s_header')
    expect((res.body as { spaceId: string }).spaceId).toBe('s_header')
  })

  it('creates in the header space when the body omits spaceId entirely', async () => {
    const res = mockRes()
    const req = {
      uid: 'u_owner',
      spaceId: 's_header',
      body: { folderId: 'f_x', title: 'Hi', docType: 'doc' },
    } as never
    await collectionHandler('post')(req, res as never)

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(docMetaRepo.create)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(docMetaRepo.create).mock.calls[0]![0].spaceId).toBe('s_header')
  })

  it('rejects (400) and never creates when the header is absent — body.spaceId must NOT be a fallback', async () => {
    const res = mockRes()
    const req = {
      uid: 'u_owner',
      // No req.spaceId (header absent). In production the middleware 400s first;
      // this asserts the handler itself no longer resurrects the request from
      // body.spaceId — the header is the single source of truth.
      body: { spaceId: 's_body_attacker', folderId: 'f_x', title: 'Hi', docType: 'doc' },
    } as never
    await collectionHandler('post')(req, res as never)

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(docMetaRepo.create)).not.toHaveBeenCalled()
  })
})
