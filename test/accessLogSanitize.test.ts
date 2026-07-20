import { describe, it, expect } from 'vitest'
import { sanitizeUrlForLog, stripLogControlChars } from '../src/api/accessLog.js'

// Guards the access-log middleware's URL sanitizer: signed blob URLs and invite
// tokens must never appear verbatim in the access log, while ordinary paths /
// non-secret query params stay readable so a decide callback is identifiable.
describe('sanitizeUrlForLog', () => {
  it('keeps the decide callback path fully readable', () => {
    expect(sanitizeUrlForLog('/api/v1/card-actions/decide')).toBe(
      '/api/v1/card-actions/decide',
    )
  })

  it('preserves non-secret query params', () => {
    expect(sanitizeUrlForLog('/api/v1/docs?page=2&status=open')).toBe(
      '/api/v1/docs?page=2&status=open',
    )
  })

  it('redacts blob gateway X-Signature', () => {
    const out = sanitizeUrlForLog(
      '/api/v1/attachments/obj-123?X-Signature=abcdef0123456789&expiry=1700000000',
    )
    expect(out).not.toContain('abcdef0123456789')
    expect(out).toContain('X-Signature=[REDACTED]')
    // non-secret param survives
    expect(out).toContain('expiry=1700000000')
  })

  it('redacts AWS-style presign params (case-insensitive)', () => {
    const out = sanitizeUrlForLog(
      '/blob/x?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA/foo',
    )
    expect(out).not.toContain('deadbeef')
    expect(out).not.toContain('AKIA')
    expect(out).toContain('X-Amz-Signature=[REDACTED]')
    expect(out).toContain('X-Amz-Credential=[REDACTED]')
  })

  it('redacts invite tokens embedded in the path', () => {
    expect(sanitizeUrlForLog('/api/v1/invites/secrettoken123/accept')).toBe(
      '/api/v1/invites/[REDACTED]/accept',
    )
    expect(sanitizeUrlForLog('/api/v1/invites/secrettoken123')).toBe(
      '/api/v1/invites/[REDACTED]',
    )
  })

  it('redacts generic token / access_token / signature keys', () => {
    const out = sanitizeUrlForLog('/x?token=aaa&access_token=bbb&signature=ccc&ok=1')
    expect(out).not.toContain('aaa')
    expect(out).not.toContain('bbb')
    expect(out).not.toContain('ccc')
    expect(out).toContain('ok=1')
  })

  it('handles paths without query strings', () => {
    expect(sanitizeUrlForLog('/health')).toBe('/health')
  })

  it('strips CR/LF so a forged URL cannot inject extra log lines', () => {
    const out = sanitizeUrlForLog('/api/v1/docs\r\n[octo-docs] POST /fake 200 0ms?page=1')
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\n')
    expect(out).toContain('\\r\\n')
  })

  it('escapes control chars in the no-query path branch', () => {
    const out = sanitizeUrlForLog('/health\ninjected')
    expect(out).not.toContain('\n')
    expect(out).toBe('/health\\ninjected')
  })

  it('stripLogControlChars escapes tab and other C0 controls', () => {
    expect(stripLogControlChars('a\tb')).toBe('a\\tb')
    expect(stripLogControlChars('a\u0000b')).toBe('a\\x00b')
    expect(stripLogControlChars('clean/path')).toBe('clean/path')
  })
})
