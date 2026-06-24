import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the single DNS resolution so we can drive resolveAndValidate
// deterministically and assert it resolves exactly once.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

import { lookup } from 'node:dns/promises'
import { isBlockedIp, resolveAndValidate, LinkCardError } from '../src/util/ssrfGuard.js'

function mockResolves(...ips: string[]) {
  vi.mocked(lookup).mockResolvedValue(ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never)
}

beforeEach(() => vi.mocked(lookup).mockReset())

describe('isBlockedIp — SSRF address classification (§3.5 ⑰)', () => {
  it('blocks loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.5.5.5',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('blocks the cloud metadata address', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true)
  })

  it('blocks loopback / ULA / link-local / IPv4-mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('does NOT block ordinary public addresses', () => {
    expect(isBlockedIp('93.184.216.34')).toBe(false) // example.com
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false)
  })

  it('fails closed on non-IP input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true)
  })
})

describe('resolveAndValidate — single resolution + post-resolution validation', () => {
  it('returns validated IPs for a public host and resolves exactly once', async () => {
    mockResolves('93.184.216.34')
    const out = await resolveAndValidate('example.com')
    expect(out).toEqual({ hostname: 'example.com', validatedIps: ['93.184.216.34'] })
    expect(vi.mocked(lookup)).toHaveBeenCalledTimes(1)
  })

  it('blocks a hostname that resolves to an internal address (DNS-resolution check)', async () => {
    mockResolves('10.0.0.5')
    await expect(resolveAndValidate('rebind.evil.test')).rejects.toMatchObject({ code: 'ssrf_blocked' })
  })

  it('blocks when ANY of multiple resolved addresses is internal', async () => {
    mockResolves('93.184.216.34', '127.0.0.1')
    await expect(resolveAndValidate('mixed.test')).rejects.toMatchObject({ code: 'ssrf_blocked' })
  })

  it('blocks the literal localhost hostname without resolving', async () => {
    await expect(resolveAndValidate('localhost')).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(vi.mocked(lookup)).not.toHaveBeenCalled()
  })

  it('maps a host that does not resolve to any address to fetch_failed', async () => {
    vi.mocked(lookup).mockResolvedValue([] as never)
    let caught: unknown
    try {
      await resolveAndValidate('nope.invalid')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LinkCardError)
    expect((caught as LinkCardError).code).toBe('fetch_failed')
  })

  it('throws a typed LinkCardError', async () => {
    mockResolves('127.0.0.1')
    await expect(resolveAndValidate('x.test')).rejects.toBeInstanceOf(LinkCardError)
  })
})

describe('resolveAndValidate — IP literals are validated directly (no DNS)', () => {
  it('blocks a bracketed IPv6 loopback literal without resolving', async () => {
    await expect(resolveAndValidate('[::1]')).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(vi.mocked(lookup)).not.toHaveBeenCalled()
  })

  it('blocks bracketed IPv4-mapped IPv6 literals without resolving', async () => {
    await expect(resolveAndValidate('[::ffff:127.0.0.1]')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
    await expect(resolveAndValidate('[::ffff:10.0.0.1]')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
    expect(vi.mocked(lookup)).not.toHaveBeenCalled()
  })

  it('blocks a bare IPv4 literal directly (no DNS)', async () => {
    await expect(resolveAndValidate('127.0.0.1')).rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(vi.mocked(lookup)).not.toHaveBeenCalled()
  })

  it('returns a public bracketed IPv6 literal without resolving', async () => {
    const out = await resolveAndValidate('[2606:2800:220:1:248:1893:25c8:1946]')
    expect(out).toEqual({
      hostname: '2606:2800:220:1:248:1893:25c8:1946',
      validatedIps: ['2606:2800:220:1:248:1893:25c8:1946'],
    })
    expect(vi.mocked(lookup)).not.toHaveBeenCalled()
  })

  it('returns a public IPv4 literal without resolving', async () => {
    const out = await resolveAndValidate('93.184.216.34')
    expect(out).toEqual({ hostname: '93.184.216.34', validatedIps: ['93.184.216.34'] })
    expect(vi.mocked(lookup)).not.toHaveBeenCalled()
  })
})
