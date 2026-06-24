import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for PUT /:docId/members (§8.4). The handler runs an
// anti-ghost-member check (getUser(uid) must resolve a real octo user) before
// upserting. Regression: getUser was called without the octo-server `token`
// header, so octo-server returned 401 -> null and every add-member 404'd. We
// mock the guard + member repo + epoch bump and inject a stub OctoIdentity to
// drive the route handler off the router stack (mirrors invitesRoutes.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { upsertDirect: vi.fn(async () => {}) },
}))
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => {}),
}))

import { membersRouter } from '../src/api/routes/members.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'

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

// Resolve the PUT add-member handler from the Express router stack.
function putMemberHandler() {
  for (const layer of (membersRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/members' && route.methods?.put) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('put-member handler not found')
}

// Request carrying the authenticated caller's octo token (set by authMiddleware
// as req.octoToken) so we can assert it is threaded into getUser.
function req(body: Record<string, unknown>, octoToken = 'caller-session-token') {
  return {
    uid: 'u_admin',
    octoToken,
    params: { docId: 'd_1' },
    body,
  } as never
}

// A stub identity whose getUser resolves only known uids; records the args it
// was called with so we can assert the caller token is forwarded.
function stubIdentity(known: Record<string, OctoUser>) {
  const getUser = vi.fn(async (uid: string, _callerToken?: string): Promise<OctoUser | null> => {
    return known[uid] ?? null
  })
  const identity: OctoIdentity = {
    verifyToken: vi.fn(async () => null),
    getUser,
    getUsers: vi.fn(async () => []),
  }
  setOctoIdentity(identity)
  return getUser
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docMemberRepo.upsertDirect).mockClear()
  vi.mocked(requireDocRole).mockResolvedValue({
    meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: 'u_admin' },
    role: 'admin',
  } as never)
})

describe('PUT /api/v1/docs/:docId/members — anti ghost-member check', () => {
  it('add member with a resolvable uid -> 200 ok', async () => {
    stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(vi.mocked(docMemberRepo.upsertDirect)).toHaveBeenCalledTimes(1)
  })

  it('add member with an unresolvable uid -> 404 user_not_found', async () => {
    stubIdentity({})
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_ghost', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
    expect(vi.mocked(docMemberRepo.upsertDirect)).not.toHaveBeenCalled()
  })

  it("forwards the caller's octo token into getUser", async () => {
    const getUser = stubIdentity({ u_real: { uid: 'u_real', name: 'Real User' } })
    const res = mockRes()
    await putMemberHandler()(req({ uid: 'u_real', role: 'reader' }, 'tok-xyz'), res as never)

    expect(res.statusCode).toBe(200)
    expect(getUser).toHaveBeenCalledWith('u_real', 'tok-xyz')
  })
})
