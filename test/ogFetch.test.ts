import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  fetchOgCard,
  parseOgCard,
  httpTransport,
  type OgFetchDeps,
  type HopResponse,
  type Transport,
} from '../src/util/ogFetch.js'
import { LinkCardError, resolveAndValidate } from '../src/util/ssrfGuard.js'

// ── pure HTML parsing ─────────────────────────────────────────────────────────

describe('parseOgCard (§3.5 ⑰ fixed contract)', () => {
  it('extracts the OG fields and resolves a relative og:image to absolute', () => {
    const html = `<html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Hello &amp; World" />
      <meta property="og:description" content="A description" />
      <meta property="og:image" content="/img/card.png" />
      <meta property="og:site_name" content="Example" />
    </head><body>ignored</body></html>`
    const card = parseOgCard(html, new URL('https://example.com/page'))
    expect(card.title).toBe('Hello & World')
    expect(card.description).toBe('A description')
    expect(card.image).toBe('https://example.com/img/card.png')
    expect(card.siteName).toBe('Example')
    expect(card.url).toBe('https://example.com/page')
    expect(typeof card.fetchedAt).toBe('string')
  })

  it('falls back to <title> and meta[name=description] when OG tags are absent', () => {
    const html = `<head><title>Just A Title</title><meta name="description" content="meta desc"></head>`
    const card = parseOgCard(html, new URL('https://example.com/'))
    expect(card.title).toBe('Just A Title')
    expect(card.description).toBe('meta desc')
    expect(card.image).toBe('')
    expect(card.siteName).toBe('')
  })

  it('returns the exact contract field set, nothing more', () => {
    const card = parseOgCard('<head></head>', new URL('https://example.com/'))
    expect(Object.keys(card).sort()).toEqual(
      ['description', 'fetchedAt', 'image', 'siteName', 'title', 'url'].sort(),
    )
  })
})

// ── orchestration with injected deps ──────────────────────────────────────────

function depsReturning(responses: HopResponse[], resolveImpl?: OgFetchDeps['resolve']): { deps: OgFetchDeps; resolve: ReturnType<typeof vi.fn>; transport: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(
    resolveImpl ??
      (async (hostname: string) => ({ hostname, validatedIps: ['93.184.216.34'] })),
  )
  let i = 0
  const transport = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!)
  return { deps: { resolve: resolve as never, transport: transport as never }, resolve, transport }
}

describe('fetchOgCard orchestration (§3.5 ⑰ SSRF / redirects)', () => {
  const okHtml: HopResponse = {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '<head><meta property="og:title" content="T"></head>',
  }

  it('rejects a non-http(s) scheme before any resolution', async () => {
    const { deps, resolve } = depsReturning([okHtml])
    await expect(fetchOgCard('ftp://example.com/x', deps)).rejects.toMatchObject({
      code: 'scheme_not_allowed',
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects a non-allowlisted port as ssrf_blocked', async () => {
    const { deps } = depsReturning([okHtml])
    await expect(fetchOgCard('http://example.com:6379/', deps)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
  })

  it('rejects an unparseable url as url_invalid', async () => {
    const { deps } = depsReturning([okHtml])
    await expect(fetchOgCard('http://', deps)).rejects.toMatchObject({ code: 'url_invalid' })
  })

  it('resolves exactly once per hop and re-validates each redirect target', async () => {
    const responses: HopResponse[] = [
      { status: 301, headers: {}, location: 'https://final.example/landing' },
      okHtml,
    ]
    const { deps, resolve, transport } = depsReturning(responses)
    const card = await fetchOgCard('https://start.example/', deps)
    expect(card.title).toBe('T')
    // One resolution per hop (start + redirect target) — the single-resolution
    // contract (§3.5 S3): no extra resolutions beyond hop count.
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenNthCalledWith(1, 'start.example')
    expect(resolve).toHaveBeenNthCalledWith(2, 'final.example')
    // The transport connects with the validated IPs from that single resolution.
    expect(transport.mock.calls[0]![1]).toEqual(['93.184.216.34'])
  })

  it('blocks a redirect that points at an internal host (per-hop validation)', async () => {
    const resolveImpl = vi.fn(async (hostname: string) => {
      if (hostname === 'evil.example') {
        throw new LinkCardError('ssrf_blocked', 'internal')
      }
      return { hostname, validatedIps: ['93.184.216.34'] }
    })
    const { deps } = depsReturning(
      [{ status: 302, headers: {}, location: 'http://evil.example/' }, okHtml],
      resolveImpl as never,
    )
    await expect(fetchOgCard('https://start.example/', deps)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
  })

  it('terminates a redirect bomb (>maxRedirects) with fetch_failed', async () => {
    const { deps, transport } = depsReturning([
      { status: 301, headers: {}, location: 'https://a.example/next' },
    ])
    await expect(fetchOgCard('https://start.example/', deps)).rejects.toMatchObject({
      code: 'fetch_failed',
    })
    // Initial + 3 redirect hops = 4 transport calls, then it stops (no infinite loop).
    expect(transport).toHaveBeenCalledTimes(4)
  })

  it('maps a non-2xx upstream status to fetch_failed', async () => {
    const { deps } = depsReturning([{ status: 500, headers: {} }])
    await expect(fetchOgCard('https://start.example/', deps)).rejects.toMatchObject({
      code: 'fetch_failed',
    })
  })

  // Exercises the real URL->hostname extraction path: `new URL('http://[::1]/')`
  // yields a BRACKETED hostname, which the guard must de-bracket and block as an
  // IP literal (not let it slip through to a DNS failure / fetch_failed).
  it('blocks an IPv6-literal URL via the real guard (ssrf_blocked, not fetch_failed)', async () => {
    const transport = vi.fn<Transport>(async () => okHtml)
    const deps: OgFetchDeps = { resolve: resolveAndValidate, transport }
    await expect(fetchOgCard('http://[::1]/', deps)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
    expect(transport).not.toHaveBeenCalled()
  })

  it('blocks an IPv4-mapped IPv6-literal URL via the real guard', async () => {
    const transport = vi.fn<Transport>(async () => okHtml)
    const deps: OgFetchDeps = { resolve: resolveAndValidate, transport }
    await expect(fetchOgCard('http://[::ffff:127.0.0.1]/', deps)).rejects.toMatchObject({
      code: 'ssrf_blocked',
    })
    expect(transport).not.toHaveBeenCalled()
  })
})

// ── real transport against a loopback server ─────────────────────────────────

describe('httpTransport (real node:http, validated-IP connect)', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  })

  const start = (handler: http.RequestListener): Promise<URL> =>
    new Promise((resolve) => {
      server = http.createServer(handler)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo
        resolve(new URL(`http://127.0.0.1:${port}/`))
      })
    })

  it('connects to the supplied validated IP and returns the HTML body', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<head><title>OK</title></head>')
    })
    const resp = await httpTransport(url, ['127.0.0.1'], 2000)
    expect(resp.status).toBe(200)
    expect(resp.body).toContain('<title>OK</title>')
  })

  it('rejects a non-HTML content type with unsupported_content_type', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('binary')
    })
    await expect(httpTransport(url, ['127.0.0.1'], 2000)).rejects.toMatchObject({
      code: 'unsupported_content_type',
    })
  })

  it('aborts and rejects when the body exceeds the size cap', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(Buffer.alloc(600 * 1024, 0x61)) // 600KB > 512KB cap
    })
    await expect(httpTransport(url, ['127.0.0.1'], 3000)).rejects.toMatchObject({
      code: 'response_too_large',
    })
  })

  it('returns the Location for a redirect without reading the body', async () => {
    const url = await start((_req, res) => {
      res.writeHead(302, { location: 'https://example.com/next' })
      res.end()
    })
    const resp = await httpTransport(url, ['127.0.0.1'], 2000)
    expect(resp.status).toBe(302)
    expect(resp.location).toBe('https://example.com/next')
  })

  it('rejects with fetch_failed when the target hangs past the timeout', async () => {
    const url = await start(() => {
      /* never responds */
    })
    await expect(httpTransport(url, ['127.0.0.1'], 150)).rejects.toMatchObject({
      code: 'fetch_failed',
    })
  })
})
