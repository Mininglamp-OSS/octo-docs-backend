/**
 * SSRF guard for the link-card OG fetch (§3.5 ⑰).
 *
 * This module owns the single DNS resolution for a host. `resolveAndValidate`
 * calls `dns.lookup(host, { all: true })` exactly ONCE, validates EVERY resolved
 * A/AAAA against the blocklist (loopback / private / link-local / CGNAT / ULA /
 * cloud-metadata / IPv4-mapped), and returns the validated IP list. The fetch
 * layer's Agent `lookup` hook then CONSUMES that list and never re-resolves —
 * which closes the DNS-rebinding (TOCTOU) window: the IP that was validated is
 * physically the IP that gets connected (§3.5 S3).
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Typed error carrying the wire `code` the link-card route maps to a status.
 * Defined here (the lowest-level module) so both ssrfGuard and ogFetch can throw
 * it without a circular import.
 */
export class LinkCardError extends Error {
  constructor(
    public readonly code: LinkCardErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'LinkCardError'
  }
}

export type LinkCardErrorCode =
  | 'url_required'
  | 'url_invalid'
  | 'scheme_not_allowed'
  | 'ssrf_blocked'
  | 'fetch_failed'
  | 'unsupported_content_type'
  | 'response_too_large'

/** Parse a dotted-quad IPv4 string into 4 octets, or null if malformed. */
function parseIpv4(s: string): number[] | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/**
 * Parse an IPv6 string (including `::` compression and a trailing embedded IPv4
 * like `::ffff:127.0.0.1`) into 16 bytes, or null if malformed. Any zone id
 * (`%eth0`) is stripped first.
 */
function parseIpv6(input: string): number[] | null {
  const addr = input.includes('%') ? input.slice(0, input.indexOf('%')) : input
  const halves = addr.split('::')
  if (halves.length > 2) return null

  const expand = (side: string): number[] | null => {
    if (side === '') return []
    const groups = side.split(':')
    const out: number[] = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!
      if (g.includes('.')) {
        // Embedded IPv4 is only valid as the final group.
        if (i !== groups.length - 1) return null
        const v4 = parseIpv4(g)
        if (!v4) return null
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
        out.push(parseInt(g, 16))
      }
    }
    return out
  }

  let hextets: number[]
  if (halves.length === 2) {
    const head = expand(halves[0]!)
    const tail = expand(halves[1]!)
    if (head === null || tail === null) return null
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null // '::' must stand for at least one zero group
    hextets = [...head, ...new Array(missing).fill(0), ...tail]
  } else {
    const all = expand(addr)
    if (all === null) return null
    hextets = all
  }
  if (hextets.length !== 8) return null

  const bytes: number[] = []
  for (const h of hextets) bytes.push((h >> 8) & 0xff, h & 0xff)
  return bytes
}

/** Loopback / private / link-local / CGNAT / metadata IPv4 ranges. */
function isBlockedIpv4(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!]
  if (a === 0) return true // 0.0.0.0/8 ("this" network, incl. 0.0.0.0)
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 172 && c >= 16 && c <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && c === 168) return true // 192.168.0.0/16 private
  if (a === 169 && c === 254) return true // 169.254.0.0/16 link-local (+ 169.254.169.254 metadata)
  if (a === 100 && c >= 64 && c <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

/** Loopback / unspecified / ULA / link-local / IPv4-mapped IPv6 ranges. */
function isBlockedIpv6(b: number[]): boolean {
  // ::ffff:0:0/96 IPv4-mapped — unwrap and re-check the embedded IPv4.
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff
  if (mapped) return isBlockedIpv4(b.slice(12, 16))

  const allZero = b.every((x) => x === 0)
  if (allZero) return true // ::/128 unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true // ::1 loopback
  if ((b[0]! & 0xfe) === 0xfc) return true // fc00::/7 ULA (covers fd00:ec2::254 metadata)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true // fe80::/10 link-local
  return false
}

/** True if `ip` (a literal v4/v6 address) falls in any blocked range. */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) {
    const v4 = parseIpv4(ip)
    return v4 === null ? true : isBlockedIpv4(v4)
  }
  if (fam === 6) {
    const v6 = parseIpv6(ip)
    return v6 === null ? true : isBlockedIpv6(v6)
  }
  return true // not a parseable IP — fail closed
}

/**
 * Resolve `hostname` ONCE and validate every resolved address. Throws
 * LinkCardError('ssrf_blocked') if any resolved IP is in a blocked range, or
 * LinkCardError('fetch_failed') if the name does not resolve. Returns the
 * original hostname plus the validated IP list for the caller's connect hook to
 * consume without re-resolving (§3.5 S3).
 */
export async function resolveAndValidate(
  hostname: string,
): Promise<{ hostname: string; validatedIps: string[] }> {
  // An IPv6 literal taken from `URL.hostname` arrives bracketed (e.g. `[::1]`);
  // strip a single surrounding pair before any processing.
  const debracketed = hostname.replace(/^\[(.*)\]$/, '$1')
  const host = debracketed.trim().toLowerCase()
  // Block the loopback alias by name up front (it would resolve to 127.0.0.1 /
  // ::1 anyway, but this is explicit and cheap).
  if (host === '' || host === 'localhost') {
    throw new LinkCardError('ssrf_blocked', `blocked host: ${hostname}`)
  }

  // An IP literal needs no resolution: validate it DIRECTLY against the
  // blocklist and SKIP DNS. This makes the guard ACTIVELY block IP literals
  // (incl. bracketed IPv6 and IPv4-mapped) rather than relying on a DNS lookup
  // failing by accident.
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new LinkCardError('ssrf_blocked', `blocked address ${host}`)
    }
    return { hostname: host, validatedIps: [host] }
  }

  let results: Array<{ address: string }>
  try {
    results = await dnsLookup(hostname, { all: true })
  } catch {
    throw new LinkCardError('fetch_failed', `dns lookup failed for ${hostname}`)
  }
  if (results.length === 0) {
    throw new LinkCardError('fetch_failed', `no addresses for ${hostname}`)
  }

  const validatedIps = results.map((r) => r.address)
  for (const ip of validatedIps) {
    if (isBlockedIp(ip)) {
      throw new LinkCardError('ssrf_blocked', `blocked address ${ip} for ${hostname}`)
    }
  }
  return { hostname, validatedIps }
}
