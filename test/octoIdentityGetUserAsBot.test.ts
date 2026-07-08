import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'
import { config } from '../src/config/env.js'

// Verify HttpOctoIdentity.getUserAsBot resolves the target user on the BOT path
// using the bot's own bearer token against octo-server's existing
// GET /v1/bot/user/info?uid=... route — NOT the AuthMiddleware-guarded
// GET /v1/users/:uid route. The bot-token realm (authBot) is separate from the
// human session/service-token realm, so this path needs no OCTO_SERVER_TOKEN.
//
// The 200-vs-404 signal is the anti ghost-member existence check: 200 -> the
// user exists (mapped to OctoUser), 404 -> the user does not (mapped to null).
//
// OCTO_SERVER_TOKEN is unset in the test env (config.octoIdentity.serviceToken
// is ''), which is exactly the deploy state this change must support.

function botUserResponse(uid: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ uid, name: 'Bot Target', avatar: 'http://octo.test/users/u_x/avatar' }),
  } as unknown as Response
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    json: async () => ({ error: { code: 'err.server.bot_api.user_not_found' } }),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.getUserAsBot — bot-token user resolution', () => {
  it('resolves via /v1/bot/user/info with Authorization: Bearer botToken (no service token needed)', async () => {
    expect(config.octoIdentity.serviceToken).toBe('')
    const fetchMock = vi.fn(async () => botUserResponse('u_real'))
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const user = await identity.getUserAsBot('u_real', 'bf_bottok')

    expect(user).toEqual({
      uid: 'u_real',
      name: 'Bot Target',
      avatar: 'http://octo.test/users/u_x/avatar',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/bot/user/info?uid=u_real')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer bf_bottok')
    // The bot realm must NOT reuse the human `token` header.
    expect(headers.token).toBeUndefined()
  })

  it('maps a 404 (user does not exist) to null so callers return not_found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFoundResponse()))
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUserAsBot('u_ghost', 'bf_bottok')).toBeNull()
  })

  it('url-encodes the uid query param', async () => {
    const fetchMock = vi.fn(async () => botUserResponse('a/b c'))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    await identity.getUserAsBot('a/b c', 'bf_bottok')
    const [url] = fetchMock.mock.calls[0]! as unknown as [string]
    expect(url).toBe('http://octo.test/v1/bot/user/info?uid=a%2Fb%20c')
  })

  it('returns null without calling fetch when the bot token is empty', async () => {
    const fetchMock = vi.fn(async () => botUserResponse('u_real'))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUserAsBot('u_real', '')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a transport error / non-ok, non-404 response as unresolved (null)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.getUserAsBot('u_real', 'bf_bottok')).toBeNull()
  })
})
