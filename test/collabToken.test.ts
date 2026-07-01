import { describe, it, expect, afterEach } from 'vitest'
import { signCollabToken, verifyCollabToken } from '../src/auth/collabToken.js'
import { config } from '../src/config/env.js'

// NOTE: config (incl. COLLAB_TOKEN_SECRET) is captured at module import time,
// so sign and verify always use the same secret here. These tests assert the
// claim contract and signature integrity rather than secret rotation.

describe('collab token sign/verify (§4.4)', () => {
  it('signs a token carrying the exact claim set and verifies it back', () => {
    const { token, role, expiresAt, permission_epoch } = signCollabToken({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:d_abc123',
      role: 'writer',
      permission_epoch: 7,
    })
    expect(typeof token).toBe('string')
    expect(role).toBe('writer')
    // The response now surfaces the real epoch alongside the signed claim, so
    // clients no longer have to default to 0 (XIN-210/211).
    expect(permission_epoch).toBe(7)
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())

    const claims = verifyCollabToken(token)
    expect(claims).toEqual({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:d_abc123',
      role: 'writer',
      permission_epoch: 7,
    })
  })

  it('rejects a tampered token (signature mismatch)', () => {
    const { token } = signCollabToken({
      uid: 'u_1',
      documentName: 'octo:s:f:d',
      role: 'reader',
      permission_epoch: 0,
    })
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa')
    expect(() => verifyCollabToken(tampered)).toThrow()
  })

  it('rejects a structurally invalid token', () => {
    expect(() => verifyCollabToken('not-a-jwt')).toThrow()
  })
})

describe('collab-token response collabWsUrl contract (§4.4)', () => {
  const original = config.collabToken.publicWsUrl

  afterEach(() => {
    // Restore the shared config singleton so this suite does not leak into others.
    ;(config.collabToken as { publicWsUrl: string }).publicWsUrl = original
  })

  const baseClaims = {
    uid: 'u_1',
    documentName: 'octo:s:f:d',
    role: 'writer' as const,
    permission_epoch: 3,
  }

  it('includes collabWsUrl (absolute URL) when publicWsUrl is configured', () => {
    ;(config.collabToken as { publicWsUrl: string }).publicWsUrl = 'ws://192.168.214.189:1234'
    const result = signCollabToken(baseClaims)
    expect(result.collabWsUrl).toBe('ws://192.168.214.189:1234')
  })

  it('omits collabWsUrl entirely (not an empty string) when publicWsUrl is unset', () => {
    ;(config.collabToken as { publicWsUrl: string }).publicWsUrl = ''
    const result = signCollabToken(baseClaims)
    expect('collabWsUrl' in result).toBe(false)
    expect(result.collabWsUrl).toBeUndefined()
  })
})
