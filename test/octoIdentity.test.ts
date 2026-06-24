import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'
import { config } from '../src/config/env.js'

// Verify HttpOctoIdentity.getUser authenticates its octo-server lookup. The
// regression was a bare fetch with no `token` header -> 401 -> null -> every
// add-member 404'd. octo-server expects a header literally named `token`.
//
// OCTO_SERVER_TOKEN is unset in the test env, so config.octoIdentity.serviceToken
// is '' and getUser must fall back to the caller's own session token.

function okUserResponse(uid: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ uid, name: 'Real User' }),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.getUser — token header', () => {
  it("sends the caller token as the `token` header when no service token is configured", async () => {
    expect(config.octoIdentity.serviceToken).toBe('')
    const fetchMock = vi.fn(async () => okUserResponse('u_real'))
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    const user = await identity.getUser('u_real', 'caller-tok')

    expect(user).toEqual({ uid: 'u_real', name: 'Real User', avatar: undefined })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/users/u_real')
    expect((init.headers as Record<string, string>).token).toBe('caller-tok')
  })

  it('sends no token header when neither service nor caller token is present', async () => {
    const fetchMock = vi.fn(async () => okUserResponse('u_real'))
    vi.stubGlobal('fetch', fetchMock)

    const identity = new HttpOctoIdentity('http://octo.test')
    await identity.getUser('u_real')

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).token).toBeUndefined()
  })
})
