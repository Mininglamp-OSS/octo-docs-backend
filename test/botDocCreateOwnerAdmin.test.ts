import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Integration test for the bot doc-create owner-grant (XIN-576): when a bot
// creates a doc via POST /v1/bot/docs, the bot's human owner (robot.creator_uid,
// surfaced by verifyBot as ownerUid) must be auto-added as an admin member so the
// owner can see the doc. The repos and epoch broadcast are mocked so no MySQL /
// Redis is needed; the create handler and both mounts run for real.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    create: vi.fn(async () => undefined),
    getByDocId: vi.fn(async () => ({ title: 'T', created_at: new Date(0) })),
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: {
    upsertDirect: vi.fn(async () => undefined),
  },
}))
// Stub the epoch side-effects (Redis publish) — the create path calls bumpEpoch
// after adding the owner; we only assert it fires, not its broadcast.
vi.mock('../src/permission/epoch.js', () => ({
  bumpEpoch: vi.fn(async () => 1),
  refreshAndPublish: vi.fn(async () => undefined),
}))

import { createApp } from '../src/api/app.js'
import { setOctoIdentity, type OctoIdentity, type OctoUser } from '../src/auth/octoIdentity.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { bumpEpoch } from '../src/permission/epoch.js'
import { ROLE_ADMIN } from '../src/permission/role.js'

const upsertDirect = vi.mocked(docMemberRepo.upsertDirect)
const create = vi.mocked(docMetaRepo.create)
const bumpEpochMock = vi.mocked(bumpEpoch)

function stub(overrides: Partial<OctoIdentity>): OctoIdentity {
  return {
    verifyToken: async () => null,
    verifyBot: async () => null,
    getUser: async (): Promise<OctoUser | null> => null,
    getUserAsBot: async (): Promise<OctoUser | null> => null,
    getUsers: async (): Promise<OctoUser[]> => [],
    ...overrides,
  }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
})

beforeEach(() => {
  upsertDirect.mockClear()
  create.mockClear()
  bumpEpochMock.mockClear()
})

describe('bot doc create auto-grants the bot owner admin (XIN-576)', () => {
  it('adds the bot owner as an admin member when the bot creates a doc', async () => {
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_tmos_bot', spaceId: 's_1', ownerUid: 'u_human' }) }),
    )
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bot Doc' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { docId: string; ownerId: string }
    // Doc owner is still the bot (existing behavior unchanged).
    expect(body.ownerId).toBe('s_tmos_bot')
    // The human owner was added as an admin member on top.
    expect(upsertDirect).toHaveBeenCalledTimes(1)
    expect(upsertDirect.mock.calls[0]![0]).toMatchObject({
      docId: body.docId,
      uid: 'u_human',
      roleNum: ROLE_ADMIN,
      grantedBy: 's_tmos_bot',
    })
    // Membership change bumps the epoch for the added owner.
    expect(bumpEpochMock).toHaveBeenCalledTimes(1)
    expect(bumpEpochMock.mock.calls[0]![2]).toBe('u_human')
  })

  it('skips the grant when the bot has no distinct human owner (owner == bot)', async () => {
    setOctoIdentity(
      stub({ verifyBot: async () => ({ uid: 's_plat_bot', spaceId: 's_1', ownerUid: 's_plat_bot' }) }),
    )
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Platform Doc' }),
    })
    expect(res.status).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('skips the grant when the bot has no human owner at all (ownerUid absent)', async () => {
    setOctoIdentity(stub({ verifyBot: async () => ({ uid: 's_bot', spaceId: 's_1' }) }))
    const res = await fetch(`${base}/v1/bot/docs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bot-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No Owner Doc' }),
    })
    expect(res.status).toBe(201)
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })

  it('does not grant on the human create path (owner is already the creator)', async () => {
    setOctoIdentity(stub({ verifyToken: async () => ({ uid: 'u_1' }) }))
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'POST',
      headers: { token: 'user-tok', 'X-Space-Id': 's_human', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Human Doc' }),
    })
    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledTimes(1)
    // No botOwnerUid on the human path => no extra member write, no epoch bump.
    expect(upsertDirect).not.toHaveBeenCalled()
    expect(bumpEpochMock).not.toHaveBeenCalled()
  })
})
