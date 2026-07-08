import { describe, it, expect, vi, afterEach } from 'vitest'

// Unit tests for verifyBot middleware (§ v4.3 bot docs API).
//
// verifyBot resolves the incoming bot bearer token via octo-server's
// /v1/auth/verify-bot and injects BOTH req.uid (bot uid) and req.spaceId (the
// space octo-server reverse-resolved). It must:
//   - set req.uid + req.spaceId from the verify-bot result,
//   - NEVER set req.octoToken (the bot path has no caller session token),
//   - NEVER read/trust a client-supplied X-Space-Id (anti-spoof),
//   - 401 when the token is missing/invalid.
import { verifyBotMiddleware } from '../src/api/middleware/verifyBot.js'
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

// A request whose header(name) resolves the given case-insensitive header map,
// mirroring Express's req.header(). uid/spaceId/octoToken start undefined so the
// tests can assert exactly what the middleware injects.
function req(headers: Record<string, string | undefined>) {
  const lower: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    uid: undefined as string | undefined,
    spaceId: undefined as string | undefined,
    octoToken: undefined as string | undefined,
    header(name: string) {
      return lower[name.toLowerCase()]
    },
  } as never
}

/** A stub identity that only implements verifyBot; other methods throw if hit. */
function stubIdentity(verifyBot: OctoIdentity['verifyBot']): OctoIdentity {
  return {
    verifyBot,
    verifyToken: async () => {
      throw new Error('verifyToken must not be called on the bot path')
    },
    getUser: async (): Promise<OctoUser | null> => {
      throw new Error('getUser not expected in this test')
    },
    getUsers: async (): Promise<OctoUser[]> => {
      throw new Error('getUsers not expected in this test')
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verifyBotMiddleware — bot identity injection (§ v4.3)', () => {
  it('injects req.uid and req.spaceId from the verify-bot result and calls next', async () => {
    setOctoIdentity(stubIdentity(async () => ({ uid: 'bot_1', spaceId: 's_from_server' })))
    const r = req({ authorization: 'Bearer bot-tok' })
    const res = mockRes()
    const next = vi.fn()

    await verifyBotMiddleware(r, res as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    const rr = r as unknown as { uid?: string; spaceId?: string; octoToken?: string }
    expect(rr.uid).toBe('bot_1')
    expect(rr.spaceId).toBe('s_from_server')
    expect(res.statusCode).toBe(0) // nothing written on the happy path
  })

  it('never sets req.octoToken (bot path has no caller session token)', async () => {
    setOctoIdentity(stubIdentity(async () => ({ uid: 'bot_1', spaceId: 's_1' })))
    const r = req({ authorization: 'Bearer bot-tok' })
    const next = vi.fn()

    await verifyBotMiddleware(r, mockRes() as never, next)

    expect((r as unknown as { octoToken?: string }).octoToken).toBeUndefined()
  })

  it('stashes the bot bearer token on req.botToken for downstream bot-realm lookups', async () => {
    setOctoIdentity(stubIdentity(async () => ({ uid: 'bot_1', spaceId: 's_1' })))
    const r = req({ authorization: 'Bearer the-bot-token' })
    const next = vi.fn()

    await verifyBotMiddleware(r, mockRes() as never, next)

    expect((r as unknown as { botToken?: string }).botToken).toBe('the-bot-token')
    // still no caller session token on the bot path
    expect((r as unknown as { octoToken?: string }).octoToken).toBeUndefined()
  })

  it('ignores a client-supplied X-Space-Id and uses the server-resolved space (anti-spoof)', async () => {
    setOctoIdentity(stubIdentity(async () => ({ uid: 'bot_1', spaceId: 's_real' })))
    const r = req({ authorization: 'Bearer bot-tok', 'X-Space-Id': 's_spoofed' })
    const next = vi.fn()

    await verifyBotMiddleware(r, mockRes() as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_real')
  })

  it('forwards the extracted token to verifyBot', async () => {
    const verifyBot = vi.fn(async () => ({ uid: 'bot_1', spaceId: 's_1' }))
    setOctoIdentity(stubIdentity(verifyBot))
    const r = req({ authorization: 'Bearer the-bot-token' })

    await verifyBotMiddleware(r, mockRes() as never, vi.fn())

    expect(verifyBot).toHaveBeenCalledWith('the-bot-token')
  })

  it('returns 401 unauthorized when verifyBot returns null and does not call next', async () => {
    setOctoIdentity(stubIdentity(async () => null))
    const r = req({ authorization: 'Bearer bad-tok' })
    const res = mockRes()
    const next = vi.fn()

    await verifyBotMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(next).not.toHaveBeenCalled()
    expect((r as unknown as { uid?: string }).uid).toBeUndefined()
  })

  it('returns 401 when no token is present (verifyBot receives an empty string)', async () => {
    const verifyBot = vi.fn(async () => null)
    setOctoIdentity(stubIdentity(verifyBot))
    const r = req({})
    const res = mockRes()
    const next = vi.fn()

    await verifyBotMiddleware(r, res as never, next)

    expect(verifyBot).toHaveBeenCalledWith('')
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})
