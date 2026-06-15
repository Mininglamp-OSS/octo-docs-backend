import { describe, it, expect } from 'vitest'
import { signCollabToken, verifyCollabToken } from '../src/auth/collabToken.js'

// NOTE: config (incl. COLLAB_TOKEN_SECRET) is captured at module import time,
// so sign and verify always use the same secret here. These tests assert the
// claim contract and signature integrity rather than secret rotation.

describe('collab token sign/verify (§4.4)', () => {
  it('signs a token carrying the exact claim set and verifies it back', () => {
    const { token, role, expiresAt } = signCollabToken({
      uid: 'u_12345',
      documentName: 'octo:s_001:f_888:d_abc123',
      role: 'writer',
      permission_epoch: 7,
    })
    expect(typeof token).toBe('string')
    expect(role).toBe('writer')
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
