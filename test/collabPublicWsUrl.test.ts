import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveCollabPublicWsUrl } from '../src/config/env.js'

// resolveCollabPublicWsUrl validates COLLAB_TOKEN_PUBLIC_WS_URL at config load.
// Cleanup contract (§4.4 / XIN-227): fail-fast in production. Now that the
// frontend has dropped its build-time WS fallback, an unset or malformed value
// leaves clients unable to reach the collab WS, so production MUST refuse to
// start (mirrors requireSafeSigningSecret's production-gated fail-fast). Outside
// production the value stays soft (warn, normalise to '' => omit collabWsUrl) so
// local dev and the test suite still boot without the var. An absolute
// ws://|wss:// URL always passes through verbatim (trimmed).

describe('resolveCollabPublicWsUrl (collab WS url validation, §4.4)', () => {
  const prevNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    // Silence the intentional warnings so the test output stays clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
  })

  it('passes through an absolute ws:// URL unchanged', () => {
    expect(resolveCollabPublicWsUrl('ws://192.168.214.189:1234')).toBe('ws://192.168.214.189:1234')
  })

  it('passes through an absolute wss:// URL unchanged', () => {
    expect(resolveCollabPublicWsUrl('wss://collab.octo.example.com')).toBe(
      'wss://collab.octo.example.com',
    )
  })

  it('accepts the scheme case-insensitively', () => {
    expect(resolveCollabPublicWsUrl('WSS://collab.example.com')).toBe('WSS://collab.example.com')
  })

  it('trims surrounding whitespace', () => {
    expect(resolveCollabPublicWsUrl('  wss://collab.example.com  ')).toBe(
      'wss://collab.example.com',
    )
  })

  it('accepts a valid absolute URL even in production', () => {
    process.env.NODE_ENV = 'production'
    expect(resolveCollabPublicWsUrl('wss://collab.example.com')).toBe('wss://collab.example.com')
  })

  describe('production fail-fast (unset/malformed refuses to start)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production'
    })

    it('throws when unset/empty', () => {
      expect(() => resolveCollabPublicWsUrl('')).toThrow()
    })

    it('throws for whitespace-only', () => {
      expect(() => resolveCollabPublicWsUrl('   ')).toThrow()
    })

    it('throws for a non-ws scheme (http/https)', () => {
      expect(() => resolveCollabPublicWsUrl('https://collab.example.com')).toThrow()
    })

    it('throws for a relative path (would resolve against the REST origin, never the WS port)', () => {
      expect(() => resolveCollabPublicWsUrl('/collab/ws')).toThrow()
    })

    it('throws for a scheme-less host:port', () => {
      expect(() => resolveCollabPublicWsUrl('collab.example.com:1234')).toThrow()
    })
  })

  describe('non-production stays soft (warn, omit — never throws)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test'
    })

    it('returns "" (omit) and warns when unset/empty', () => {
      expect(resolveCollabPublicWsUrl('')).toBe('')
      // eslint-disable-next-line no-console
      expect(console.warn).toHaveBeenCalledOnce()
    })

    it('returns "" (omit) for whitespace-only', () => {
      expect(resolveCollabPublicWsUrl('   ')).toBe('')
    })

    it('returns "" (omit) and warns for a non-ws scheme', () => {
      expect(resolveCollabPublicWsUrl('https://collab.example.com')).toBe('')
      // eslint-disable-next-line no-console
      expect(console.warn).toHaveBeenCalledOnce()
    })

    it('never throws outside production', () => {
      expect(() => resolveCollabPublicWsUrl('bogus')).not.toThrow()
    })
  })
})
