/**
 * Safe outbound OG fetch for the link-card endpoint (§3.5 ⑰).
 *
 * Built on `node:http`/`node:https` with a custom Agent `lookup` hook rather
 * than global `fetch`, because we must (a) connect to an IP that was already
 * validated rather than re-resolving (DNS-rebinding defence, §3.5 S3) and (b)
 * follow redirects manually so EVERY hop is re-validated. Security invariants:
 *   · scheme whitelist http/https, port allowlist (default 80/443);
 *   · connect to a validated IP, but Host header + TLS SNI + cert validation all
 *     use the hostname, and `rejectUnauthorized` is NEVER disabled (§3.5 S2);
 *   · max N redirect hops, each re-running resolveAndValidate on the new host;
 *   · total timeout, 512KB response cap, Content-Type restricted to HTML;
 *   · lightweight regex parse of <head> only — no sub-resource fetch, no script
 *     execution.
 */
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { config } from '../config/env.js'
import { LinkCardError, resolveAndValidate } from './ssrfGuard.js'

/** Fixed, frontend-locked response contract (§3.5 A5). */
export interface OgCard {
  url: string
  title: string
  description: string
  image: string
  siteName: string
  fetchedAt: string
}

/** One transport hop's outcome. `body` is only populated for a 2xx HTML response. */
export interface HopResponse {
  status: number
  headers: http.IncomingHttpHeaders
  location?: string
  body?: string
}

/** Performs a single GET against `target`, connecting only to a validated IP. */
export type Transport = (
  target: URL,
  validatedIps: string[],
  timeoutMs: number,
) => Promise<HopResponse>

export interface OgFetchDeps {
  resolve: typeof resolveAndValidate
  transport: Transport
}

/**
 * Build a DNS `lookup` hook that returns a pre-validated IP and NEVER resolves.
 * This is the consume-only half of §3.5 S3: the IP handed to the socket is
 * physically one of the IPs ssrfGuard already validated.
 */
function staticLookup(ips: string[]): LookupFunction {
  const ip = ips[0]!
  const family = isIP(ip) || 4
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

/** Real network transport. Connects to a validated IP; identity stays hostname. */
export const httpTransport: Transport = (target, validatedIps, timeoutMs) =>
  new Promise<HopResponse>((resolve, reject) => {
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
        Accept: 'text/html,application/xhtml+xml',
      },
      lookup: staticLookup(validatedIps),
      timeout: timeoutMs,
    }
    // Connect to the validated IP but keep TLS identity on the hostname: SNI =
    // hostname, default cert validation (rejectUnauthorized stays true) (§3.5 S2).
    if (isHttps) options.servername = target.hostname

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

      // Redirect: hand the Location back to the orchestrator (which re-validates
      // the new host); don't read the body.
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

      const ctRaw = res.headers['content-type'] ?? ''
      const ct = (Array.isArray(ctRaw) ? ctRaw[0]! : ctRaw).split(';')[0]!.trim().toLowerCase()
      if (ct !== 'text/html' && ct !== 'application/xhtml+xml') {
        res.resume()
        fail(new LinkCardError('unsupported_content_type', ct || 'unknown'))
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > config.og.maxResponseBytes) {
          fail(new LinkCardError('response_too_large'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        if (settled) return
        settled = true
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', (e) => fail(new LinkCardError('fetch_failed', e.message)))
    })
    req.on('timeout', () => fail(new LinkCardError('fetch_failed', 'request timeout')))
    req.on('error', (e) => fail(new LinkCardError('fetch_failed', e.message)))
    req.end()
  })

const defaultDeps: OgFetchDeps = { resolve: resolveAndValidate, transport: httpTransport }

/** Parsed port allowlist from config. */
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

/**
 * Fetch and parse an OG link card. `deps` is injectable for tests; production
 * callers use the real resolve + transport defaults. Each redirect hop re-runs
 * `deps.resolve` (one DNS resolution per hop) before connecting.
 */
export async function fetchOgCard(rawUrl: string, deps: OgFetchDeps = defaultDeps): Promise<OgCard> {
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
    const { validatedIps } = await deps.resolve(current.hostname)

    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new LinkCardError('fetch_failed', 'timeout')

    const resp = await deps.transport(current, validatedIps, remaining)

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
    if (resp.status < 200 || resp.status >= 300) {
      throw new LinkCardError('fetch_failed', `upstream status ${resp.status}`)
    }
    return parseOgCard(resp.body ?? '', current)
  }
  // Loop exits only via return/throw above; this satisfies the type checker.
  throw new LinkCardError('fetch_failed', 'too many redirects')
}

// ── HTML parsing (lightweight; <head> meta + <title> only) ────────────────────

/** Decode the handful of HTML entities that appear in meta/title text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** Read an attribute value (double/single/unquoted) from a single tag string. */
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s">]+))`, 'i'))
  if (!m) return undefined
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
}

/**
 * Parse OG/meta fields from `html` and normalize into the fixed card contract.
 * Relative `og:image` URLs are resolved against the final URL; that image URL is
 * only returned for the frontend to render — it is never fetched here.
 */
export function parseOgCard(html: string, finalUrl: URL): OgCard {
  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html
  const metas = head.match(/<meta\b[^>]*>/gi) ?? []

  const props: Record<string, string> = {}
  for (const tag of metas) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase()
    const content = attr(tag, 'content')
    if (key && content !== undefined && props[key] === undefined) props[key] = content
  }

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const title = props['og:title'] ?? (titleTag !== undefined ? decodeEntities(titleTag) : '') ?? ''
  const description = props['og:description'] ?? props['description'] ?? ''
  const siteName = props['og:site_name'] ?? ''

  let image = ''
  const rawImage = props['og:image'] ?? props['og:image:url']
  if (rawImage) {
    try {
      image = new URL(rawImage, finalUrl).toString()
    } catch {
      image = ''
    }
  }

  return {
    url: finalUrl.toString(),
    title,
    description,
    image,
    siteName,
    fetchedAt: new Date().toISOString(),
  }
}
