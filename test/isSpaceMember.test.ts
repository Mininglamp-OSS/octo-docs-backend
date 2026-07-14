import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'

// isSpaceMember (#64, design §4.3/§4.4): POST /v1/auth/space-membership with the
// service credential, fail-closed on ANY failure, coalesced + short-TTL cached
// per {uid, spaceId}. A fresh HttpOctoIdentity per test gives each its own cache.

function membershipResponse(isMember: boolean) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ space_id: 's1', uid: 'u_1', is_member: isMember, role: 0 }),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.isSpaceMember (#64)', () => {
  it('POSTs the {space_id, uid} body and returns is_member', async () => {
    const fetchMock = vi.fn(async () => membershipResponse(true))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')

    expect(await identity.isSpaceMember('u_1', 's1')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/auth/space-membership')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ space_id: 's1', uid: 'u_1' })
  })

  it('returns false for a confirmed non-member', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => membershipResponse(false)))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1')).toBe(false)
  })

  it('fail-closed: non-200 => false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1')).toBe(false)
  })

  it('fail-closed: transport throw (unreachable) => false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1')).toBe(false)
  })

  it('fail-closed: malformed body (missing/typeless is_member) => false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1')).toBe(false)
  })

  it('short-circuits empty uid / spaceId without any IO', async () => {
    const fetchMock = vi.fn(async () => membershipResponse(true))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.isSpaceMember('', 's1')).toBe(false)
    expect(await identity.isSpaceMember('u_1', '')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches a confirmed answer per {uid, spaceId} (one fetch for repeated calls)', async () => {
    const fetchMock = vi.fn(async () => membershipResponse(true))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')

    expect(await identity.isSpaceMember('u_1', 's1')).toBe(true)
    expect(await identity.isSpaceMember('u_1', 's1')).toBe(true)
    expect(await identity.isSpaceMember('u_1', 's1')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A different {uid, spaceId} is a distinct cache key => a second fetch.
    await identity.isSpaceMember('u_2', 's1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache a fail-closed transport error (next call retries)', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return membershipResponse(true)
    })
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')

    expect(await identity.isSpaceMember('u_1', 's1')).toBe(false) // fail-closed, uncached
    expect(await identity.isSpaceMember('u_1', 's1')).toBe(true) // retried, now confirmed
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
