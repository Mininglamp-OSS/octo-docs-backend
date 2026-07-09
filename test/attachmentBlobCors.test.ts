import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Integration test for the self-hosted attachment blob gateway + CORS (XIN-717).
//
// With the `local-hmac` driver and ATTACHMENT_PUBLIC_BASE_URL pointed at the
// docs-backend origin, the front-end issues the presigned PUT/GET directly at
// this origin. The browser therefore sends a CORS preflight OPTIONS first, and
// the actual PUT/GET must carry Access-Control-Allow-Origin. This test drives a
// real ephemeral server built from createApp() and asserts:
//   - OPTIONS preflight on the signed PUT URL returns 2xx with the CORS headers,
//   - the PUT stores the bytes and its response carries Access-Control-Allow-Origin,
//   - the GET returns the same bytes with ACAO + nosniff,
//   - a tampered signature is rejected 403,
//   - an origin outside the allowlist gets no ACAO.
//
// The env is configured BEFORE importing config/env.js (read once at load).
const FE_ORIGIN = 'http://192.168.214.189:3010'
const STORE_DIR = mkdtempSync(join(tmpdir(), 'octo-blob-test-'))
process.env.ATTACHMENT_DRIVER = 'local-hmac'
process.env.ATTACHMENT_PUBLIC_BASE_URL = 'http://127.0.0.1:0/attachments'
process.env.ATTACHMENT_SIGNING_SECRET = 'blob-gateway-test-secret'
process.env.ATTACHMENT_LOCAL_DIR = STORE_DIR
process.env.CORS_ALLOWED_ORIGINS = FE_ORIGIN

const { createApp } = await import('../src/api/app.js')
const { LocalHmacObjectStore } = await import('../src/storage/objectStore.js')

let server: Server
let base: string

/** Rewrite a signed URL (minted against publicBaseUrl) onto the live test host. */
function onLiveHost(signedUrl: string): string {
  const u = new URL(signedUrl)
  const live = new URL(base)
  u.protocol = live.protocol
  u.host = live.host
  return u.toString()
}

beforeAll(async () => {
  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  rmSync(STORE_DIR, { recursive: true, force: true })
})

function store() {
  // Same secret/base as the running app so the minted URLs verify server-side.
  return new LocalHmacObjectStore()
}

const OBJECT_KEY = 'd_1/att_blob/photo.png'

describe('attachment blob gateway CORS preflight (XIN-717)', () => {
  it('answers the OPTIONS preflight on the presigned PUT url with 2xx + CORS headers', async () => {
    const { uploadUrl } = store().presignPut(OBJECT_KEY, 'image/png', 300)
    const res = await fetch(onLiveHost(uploadUrl), {
      method: 'OPTIONS',
      headers: {
        Origin: FE_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('access-control-allow-origin')).toBe(FE_ORIGIN)
    expect((res.headers.get('access-control-allow-methods') ?? '').toUpperCase()).toContain('PUT')
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'content-type',
    )
  })

  it('stores the PUT body and the PUT response carries Access-Control-Allow-Origin', async () => {
    const { uploadUrl, headers } = store().presignPut(OBJECT_KEY, 'image/png', 300)
    const body = Buffer.from('PNGDATA-xin717', 'utf8')
    const res = await fetch(onLiveHost(uploadUrl), {
      method: 'PUT',
      headers: { ...headers, Origin: FE_ORIGIN },
      body,
    })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('access-control-allow-origin')).toBe(FE_ORIGIN)
  })

  it('serves the stored bytes on GET with ACAO + nosniff', async () => {
    const signed = store().presignGet(OBJECT_KEY, 600)
    const res = await fetch(onLiveHost(signed), { headers: { Origin: FE_ORIGIN } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(FE_ORIGIN)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('PNGDATA-xin717')
  })

  it('rejects a tampered signature with 403', async () => {
    const { uploadUrl } = store().presignPut(OBJECT_KEY, 'image/png', 300)
    const tampered = uploadUrl.replace(/X-Signature=[0-9a-f]+/, 'X-Signature=deadbeef')
    const res = await fetch(onLiveHost(tampered), {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', Origin: FE_ORIGIN },
      body: Buffer.from('nope'),
    })
    expect(res.status).toBe(403)
  })

  it('omits Access-Control-Allow-Origin for an origin outside the allowlist', async () => {
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers the API preflight with the allowed FE origin', async () => {
    const res = await fetch(`${base}/api/v1/docs`, {
      method: 'OPTIONS',
      headers: {
        Origin: FE_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'token, x-space-id',
      },
    })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('access-control-allow-origin')).toBe(FE_ORIGIN)
  })
})
