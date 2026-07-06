import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level tests for strict by-space isolation (P1): list and create must
// source the space from the enforced X-Space-Id header (req.spaceId), never from
// a client-supplied query/body field. We mock docMetaRepo and drive the GET '/'
// and POST '/' handlers off the docsRouter stack (mirrors membersRoutes.test.ts).
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

// Resolve a handler registered on docsRouter for the collection path '/'.
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

describe('GET /api/v1/docs — list is scoped to the header space', () => {
  it('passes req.spaceId to listForUser and ignores query.spaceId', async () => {
    const res = mockRes()
    const req = {
      uid: 'u_1',
      spaceId: 's_header',
      // A stray query.spaceId must NOT override the enforced header space.
      query: { spaceId: 's_query_attacker', page: '1', pageSize: '20' },
    } as never
    await collectionHandler('get')(req, res as never)

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMetaRepo.listForUser)).toHaveBeenCalledTimes(1)
    const args = vi.mocked(docMetaRepo.listForUser).mock.calls[0]![0]
    expect(args.spaceId).toBe('s_header')
    expect(args.uid).toBe('u_1')
  })
})

describe('POST /api/v1/docs — create persists into the header space', () => {
  it('builds the documentName and creates the row in req.spaceId, ignoring body.spaceId', async () => {
    const res = mockRes()
    const req = {
      uid: 'u_owner',
      spaceId: 's_header',
      // body.spaceId is a P1 transitional fallback and must be overridden by the
      // header when present (removal deferred to P3).
      body: { spaceId: 's_body_attacker', folderId: 'f_x', title: 'Hello', docType: 'doc' },
    } as never
    await collectionHandler('post')(req, res as never)

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(docMetaRepo.create)).toHaveBeenCalledTimes(1)
    const input = vi.mocked(docMetaRepo.create).mock.calls[0]![0]
    expect(input.spaceId).toBe('s_header')
    // documentName's space segment (2nd) must be the header space, not the body.
    expect(input.documentName.split(':')[1]).toBe('s_header')
    // folder is preserved as the 3rd segment (§8.1 invariant).
    expect(input.documentName.split(':')[2]).toBe('f_x')
    // The response echoes the header space.
    expect((res.body as { spaceId: string }).spaceId).toBe('s_header')
  })
})
