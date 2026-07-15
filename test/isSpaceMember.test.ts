import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpOctoIdentity } from '../src/auth/octoIdentity.js'

// isSpaceMember (#64, design §4.3/§4.4 — Plan B): resolved by REUSING
// POST /v1/auth/verify?include=context with the caller's OWN session token, so
// membership is `spaceId ∈ spaces` from the token holder's server-validated
// context. No dedicated internal endpoint / service secret. Fail-closed on ANY
// failure, coalesced + short-TTL cached per {uid, spaceId}. A fresh
// HttpOctoIdentity per test gives each its own cache.

const TOKEN = 'sess_tok_u1'

/** A verify?include=context response for uid `u_1` with the given spaces list. */
function verifyResponse(spaces: string[], overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      uid: 'u_1',
      name: 'User One',
      role: '',
      owned_bots: [],
      context_included: true,
      spaces,
      owned_bots_by_space: {},
      ...overrides,
    }),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpOctoIdentity.isSpaceMember (#64, verify?include=context)', () => {
  it('POSTs {token} to verify?include=context and returns true when spaceId ∈ spaces', async () => {
    const fetchMock = vi.fn(async () => verifyResponse(['s0', 's1', 's2']))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')

    expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://octo.test/v1/auth/verify?include=context')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN })
  })

  it('returns false for a confirmed non-member (spaceId not in spaces)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => verifyResponse(['s0', 's2'])))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('returns false when the token holder belongs to zero spaces', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => verifyResponse([])))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('fail-closed: non-200 => false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('fail-closed: transport throw (unreachable) => false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('fail-closed: malformed body (spaces not an array) => false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => verifyResponse([], { spaces: 'nope' })))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('fail-closed: response did NOT carry context (pre-context server) => false, even if a spaces array leaks in', async () => {
    // context_included absent must not be treated as "confirmed"; an accidental
    // spaces field without the flag is still un-confirmable.
    vi.stubGlobal('fetch', vi.fn(async () => verifyResponse(['s1'], { context_included: undefined })))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('fail-closed: verify resolved a DIFFERENT uid than the one checked => false (token/uid disagree)', async () => {
    // Defense-in-depth on the "token holder only" boundary: verify answers for
    // the token's own uid; if it is not the uid we are checking, membership can
    // never be confirmed for that uid.
    vi.stubGlobal('fetch', vi.fn(async () => verifyResponse(['s1'], { uid: 'u_other' })))
    expect(await new HttpOctoIdentity('http://octo.test').isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
  })

  it('short-circuits empty uid / spaceId / token without any IO', async () => {
    const fetchMock = vi.fn(async () => verifyResponse(['s1']))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')
    expect(await identity.isSpaceMember('', 's1', TOKEN)).toBe(false)
    expect(await identity.isSpaceMember('u_1', '', TOKEN)).toBe(false)
    expect(await identity.isSpaceMember('u_1', 's1', '')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches a confirmed answer per {uid, spaceId} (one fetch for repeated calls)', async () => {
    const fetchMock = vi.fn(async () => verifyResponse(['s1']))
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')

    expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true)
    expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true)
    expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A different {uid, spaceId} is a distinct cache key => a second fetch.
    await identity.isSpaceMember('u_1', 's_other', TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache a fail-closed transport error (next call retries)', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return verifyResponse(['s1'])
    })
    vi.stubGlobal('fetch', fetchMock)
    const identity = new HttpOctoIdentity('http://octo.test')

    expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(false) // fail-closed, uncached
    expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true) // retried, now confirmed
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds a confirmed answer to the cache TTL: a revocation is picked up after it expires (#64 N5)', async () => {
    // Decision #3: membership revocation is not epoch-bounded on the live socket;
    // the exposure bound is this cache TTL (SPACE_MEMBERSHIP_CACHE_TTL_SECONDS,
    // default 30s) for callers that re-derive membership (the REST recheck path).
    // Prove the bound: a cached `true` is NOT served indefinitely — once the TTL
    // elapses the next call re-fetches and observes the fresh (now empty) spaces.
    vi.useFakeTimers()
    try {
      let spaces = ['s1']
      const fetchMock = vi.fn(async () => verifyResponse(spaces))
      vi.stubGlobal('fetch', fetchMock)
      const identity = new HttpOctoIdentity('http://octo.test')

      expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true)
      spaces = [] // user removed from the space
      // Within the TTL the stale confirmed `true` is still served (bounded window).
      vi.advanceTimersByTime(29_000)
      expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // Past the 30s TTL the entry expires => re-fetch observes the revocation.
      vi.advanceTimersByTime(2_000)
      expect(await identity.isSpaceMember('u_1', 's1', TOKEN)).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
