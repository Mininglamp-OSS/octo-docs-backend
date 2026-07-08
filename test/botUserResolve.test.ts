import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit tests proving the bot path resolves the target user with the
// bot's own token (req.botToken -> getUserAsBot) instead of the service/session
// token (req.octoToken -> getUser). This is what lets bot member-add and
// forward-grant work with OCTO_SERVER_TOKEN empty.
//
// The guard + repos + grant core are mocked; only the resolver-credential
// selection and the 200/404 mapping are under test. The human path (req.octoToken
// set, no req.botToken) must keep calling getUser, byte-for-byte.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { upsertDirect: vi.fn(async () => {}) },
}))
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => {}),
}))
vi.mock('../src/api/services/grantForward.js', () => ({
  grantForwardAccess: vi.fn(async () => ({ finalRole: 'reader', changed: true })),
}))

import { membersRouter } from '../src/api/routes/members.js'
import { forwardGrantRouter } from '../src/api/routes/forwardGrant.js'
import { requireDocRole } from '../src/api/guard.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { grantForwardAccess } from '../src/api/services/grantForward.js'
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeHandler(router: any, path: string, method: 'put' | 'post') {
  for (const layer of router.stack) {
    const route = layer.route
    if (route && route.path === path && route.methods?.[method]) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error(`${method} ${path} handler not found`)
}
const putMember = () => routeHandler(membersRouter, '/:docId/members', 'put')
const postForward = () => routeHandler(forwardGrantRouter, '/:docId/forward-grant', 'post')

/**
 * Stub identity recording BOTH resolvers. getUser (service/session token) and
 * getUserAsBot (bot token) each resolve only known uids so tests can assert
 * which one the handler picked and with what credential.
 */
function stubIdentity(known: Record<string, OctoUser>) {
  const getUser = vi.fn(async (uid: string, _t?: string): Promise<OctoUser | null> => known[uid] ?? null)
  const getUserAsBot = vi.fn(async (uid: string, _t: string): Promise<OctoUser | null> => known[uid] ?? null)
  const identity = {
    verifyToken: vi.fn(async () => null),
    verifyBot: vi.fn(async () => null),
    getUser,
    getUserAsBot,
    getUsers: vi.fn(async () => []),
  } as unknown as OctoIdentity
  setOctoIdentity(identity)
  return { getUser, getUserAsBot }
}

// Bot-path request: verifyBot set req.uid + req.spaceId + req.botToken and
// deliberately left req.octoToken undefined (no caller session token).
function botReq(body: Record<string, unknown>, botToken = 'bf_bottok') {
  return { uid: 'bot_1', spaceId: 's_bot', botToken, params: { docId: 'd_1' }, body } as never
}
// Human-path request: authMiddleware set req.octoToken and never sets botToken.
function humanReq(body: Record<string, unknown>, octoToken = 'caller-session-token') {
  return { uid: 'u_admin', spaceId: 's1', octoToken, params: { docId: 'd_1' }, body } as never
}

const okGuard = {
  meta: { doc_id: 'd_1', document_name: 'doc-d_1', owner_id: 'u_admin' },
  role: 'admin',
} as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(requireDocRole).mockResolvedValue(okGuard)
  vi.mocked(docMemberRepo.upsertDirect).mockClear()
  vi.mocked(grantForwardAccess).mockClear()
})

describe('bot path resolves the target user with the bot token (OCTO_SERVER_TOKEN empty)', () => {
  it('PUT members: real user resolved via getUserAsBot(botToken) -> 200; getUser untouched', async () => {
    const { getUser, getUserAsBot } = stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await putMember()(botReq({ uid: 'u_real', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(getUserAsBot).toHaveBeenCalledWith('u_real', 'bf_bottok')
    expect(getUser).not.toHaveBeenCalled()
    expect(vi.mocked(docMemberRepo.upsertDirect)).toHaveBeenCalledTimes(1)
  })

  it('PUT members: ghost user on the bot path -> 404 user_not_found, no write', async () => {
    const { getUserAsBot } = stubIdentity({})
    const res = mockRes()
    await putMember()(botReq({ uid: 'u_ghost', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
    expect(getUserAsBot).toHaveBeenCalledWith('u_ghost', 'bf_bottok')
    expect(vi.mocked(docMemberRepo.upsertDirect)).not.toHaveBeenCalled()
  })

  it('POST forward-grant: real user resolved via getUserAsBot(botToken) -> 200; getUser untouched', async () => {
    const { getUser, getUserAsBot } = stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await postForward()(botReq({ uid: 'u_real', role: 'reader' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true, role: 'reader', changed: true })
    expect(getUserAsBot).toHaveBeenCalledWith('u_real', 'bf_bottok')
    expect(getUser).not.toHaveBeenCalled()
    expect(vi.mocked(grantForwardAccess)).toHaveBeenCalledTimes(1)
  })

  it('POST forward-grant: ghost user on the bot path -> 404 user_not_found, no grant', async () => {
    stubIdentity({})
    const res = mockRes()
    await postForward()(botReq({ uid: 'u_ghost', role: 'writer' }), res as never)

    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'user_not_found' })
    expect(vi.mocked(grantForwardAccess)).not.toHaveBeenCalled()
  })
})

describe('human path is unchanged (still resolves via getUser with the caller token)', () => {
  it('PUT members: uses getUser(uid, octoToken); getUserAsBot untouched', async () => {
    const { getUser, getUserAsBot } = stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await putMember()(humanReq({ uid: 'u_real', role: 'reader' }, 'tok-xyz'), res as never)

    expect(res.statusCode).toBe(200)
    expect(getUser).toHaveBeenCalledWith('u_real', 'tok-xyz')
    expect(getUserAsBot).not.toHaveBeenCalled()
  })

  it('POST forward-grant: uses getUser(uid, octoToken); getUserAsBot untouched', async () => {
    const { getUser, getUserAsBot } = stubIdentity({ u_real: { uid: 'u_real', name: 'Real' } })
    const res = mockRes()
    await postForward()(humanReq({ uid: 'u_real', role: 'reader' }, 'tok-xyz'), res as never)

    expect(res.statusCode).toBe(200)
    expect(getUser).toHaveBeenCalledWith('u_real', 'tok-xyz')
    expect(getUserAsBot).not.toHaveBeenCalled()
  })
})
