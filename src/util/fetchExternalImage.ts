/**
 * SSRF-safe binary fetch for EXTERNAL images referenced by a Markdown/PDF import.
 *
 * When an imported document references an image that our service did NOT store (a plain
 * external URL like https://blog.example.com/x.png), the import flow may re-host it under the
 * new doc so the document does not silently break if the external host later 404s. Downloading
 * an arbitrary user-supplied URL server-side is a classic SSRF vector, so this module reuses the
 * link-card SSRF guard (single DNS resolution per hop, every resolved IP validated against the
 * loopback / private / link-local / CGNAT / ULA / cloud-metadata blocklist, connect pinned to
 * the validated IP so a DNS-rebind cannot swap it) and additionally:
 *   - allows only http/https on the OG port allowlist (80/443 by default),
 *   - caps the response size (streamed, aborts as soon as the cap is exceeded),
 *   - follows a bounded number of redirects, re-validating each hop,
 *   - returns the raw bytes; the CALLER validates the mime by magic number (never trust the
 *     Content-Type header or the URL extension).
 */
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { config } from '../config/env.js'
import { resolveAndValidate, LinkCardError } from './ssrfGuard.js'

export interface FetchedImage {
  bytes: Buffer
  /** The Content-Type the origin declared (advisory only; caller sniffs magic bytes). */
  declaredContentType: string | null
}

/** node dns.lookup replacement that always yields a pre-validated IP (no re-resolution). */
function staticLookup(ip: string): LookupFunction {
  const family = ip.includes(':') ? 6 : 4
  const fn = (
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ): void => {
    if (typeof options === 'function') {
      ;(options as (...a: unknown[]) => void)(null, ip, family)
    } else if (options && (options as { all?: boolean }).all) {
      callback(null, [{ address: ip, family }])
    } else {
      callback(null, ip, family)
    }
  }
  return fn as unknown as LookupFunction
}

function allowedPorts(): number[] {
  return config.og.allowedPorts
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0)
}

function assertSchemeAndPort(u: URL): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new LinkCardError('scheme_not_allowed', u.protocol)
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if (!allowedPorts().includes(port)) {
    throw new LinkCardError('ssrf_blocked', `port ${port} not allowed`)
  }
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  location?: string
  bytes?: Buffer
}

/** One SSRF-pinned GET to a single validated IP, streaming with a hard size cap. */
function getOnce(target: URL, validatedIps: string[], timeoutMs: number, maxBytes: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    const mod = isHttps ? https : http
    const port = target.port ? Number(target.port) : isHttps ? 443 : 80
    const options: https.RequestOptions = {
      method: 'GET',
      hostname: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      headers: {
        Host: target.host,
        'User-Agent': config.og.userAgent,
        Accept: 'image/*',
      },
      lookup: staticLookup(validatedIps[0]!),
      timeout: timeoutMs,
    }
    if (isHttps) options.servername = target.hostname

    // eslint-disable-next-line prefer-const
    let req: http.ClientRequest
    let settled = false
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      req.destroy()
      reject(e)
    }

    req = mod.request(options, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        const loc = res.headers.location
        res.resume()
        if (!settled) {
          settled = true
          resolve({ status, headers: res.headers, location: Array.isArray(loc) ? loc[0] : loc })
        }
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        if (!settled) {
          settled = true
          resolve({ status, headers: res.headers })
        }
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBytes) {
          fail(new LinkCardError('response_too_large'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        if (settled) return
        settled = true
        resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) })
      })
      res.on('error', (e) => fail(new LinkCardError('fetch_failed', e.message)))
    })
    req.on('timeout', () => fail(new LinkCardError('fetch_failed', 'request timeout')))
    req.on('error', (e) => fail(new LinkCardError('fetch_failed', e.message)))
    req.end()
  })
}

/**
 * Fetch an external image URL with full SSRF protection and a size cap. Throws LinkCardError on
 * any failure (bad scheme/port, blocked address, too large, upstream error, too many redirects).
 * The returned bytes are unvalidated; the caller MUST sniff the magic number before storing.
 */
export async function fetchExternalImage(rawUrl: string, maxBytes: number): Promise<FetchedImage> {
  let current: URL
  try {
    current = new URL(rawUrl)
  } catch {
    throw new LinkCardError('url_invalid', `not a valid url: ${rawUrl}`)
  }
  const deadline = Date.now() + config.og.fetchTimeoutMs
  const maxHops = config.og.maxRedirects

  for (let hop = 0; hop <= maxHops; hop++) {
    assertSchemeAndPort(current)
    const { validatedIps } = await resolveAndValidate(current.hostname)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new LinkCardError('fetch_failed', 'timeout')

    const resp = await getOnce(current, validatedIps, remaining, maxBytes)
    if (resp.status >= 300 && resp.status < 400) {
      if (hop === maxHops) throw new LinkCardError('fetch_failed', 'too many redirects')
      if (!resp.location) throw new LinkCardError('fetch_failed', 'redirect without location')
      try {
        current = new URL(resp.location, current)
      } catch {
        throw new LinkCardError('fetch_failed', `bad redirect location: ${resp.location}`)
      }
      continue
    }
    if (resp.status < 200 || resp.status >= 300 || !resp.bytes) {
      throw new LinkCardError('fetch_failed', `upstream status ${resp.status}`)
    }
    const ctRaw = resp.headers['content-type'] ?? ''
    const declaredContentType = (Array.isArray(ctRaw) ? ctRaw[0]! : ctRaw).split(';')[0]!.trim().toLowerCase() || null
    return { bytes: resp.bytes, declaredContentType }
  }
  throw new LinkCardError('fetch_failed', 'too many redirects')
}
