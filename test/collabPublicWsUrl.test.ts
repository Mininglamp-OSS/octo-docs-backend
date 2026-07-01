import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveCollabPublicWsUrl } from '../src/config/env.js'

// resolveCollabPublicWsUrl validates COLLAB_TOKEN_PUBLIC_WS_URL at config load.
// Phase-1 contract (§4.4 / XIN-211): soft-warn only, never throw. An unset or
// malformed value normalises to '' ("omit collabWsUrl"); an absolute ws://|wss://
// URL passes through verbatim (trimmed).

describe('resolveCollabPublicWsUrl (collab WS url validation, §4.4)', () => {
  beforeEach(() => {
    // Silence the intentional warnings so the test output stays clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
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

  it('returns "" (omit) and warns when unset/empty', () => {
    expect(resolveCollabPublicWsUrl('')).toBe('')
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('returns "" (omit) for whitespace-only', () => {
    expect(resolveCollabPublicWsUrl('   ')).toBe('')
  })

  it('rejects a non-ws scheme (http/https) — returns "" and warns', () => {
    expect(resolveCollabPublicWsUrl('https://collab.example.com')).toBe('')
    // eslint-disable-next-line no-console
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('rejects a relative path (would resolve against the REST origin, never the WS port)', () => {
    expect(resolveCollabPublicWsUrl('/collab/ws')).toBe('')
  })

  it('rejects a scheme-less host:port', () => {
    expect(resolveCollabPublicWsUrl('collab.example.com:1234')).toBe('')
  })

  it('never throws — phase-1 is soft-warn only, not fail-fast', () => {
    expect(() => resolveCollabPublicWsUrl('bogus')).not.toThrow()
  })
})
