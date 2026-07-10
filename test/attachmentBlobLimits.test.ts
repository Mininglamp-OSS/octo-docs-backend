import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// XIN-728 — OOM DoS hardening on the self-hosted attachment blob gateway.
//
// Two blockers are exercised end-to-end against a real ephemeral server:
//   1. the upload PUT is bounded — a body past the size cap is rejected 413 and
//      is streamed (not fully buffered), so no oversized object is persisted;
//   2. the blob PUT/GET surface is now BEHIND a per-IP rate limiter, so a flood
//      of signed uploads is throttled instead of bypassing throttling entirely.
//
// A small max body size and a tiny rate-limit budget are injected via env /
// createApp() so both limits are reachable in a handful of requests.
const STORE_DIR = mkdtempSync(join(tmpdir(), 'octo-blob-limits-'))
const MAX_BYTES = 1024 // 1 KiB cap for the test
process.env.ATTACHMENT_DRIVER = 'local-hmac'
process.env.ATTACHMENT_PUBLIC_BASE_URL = 'http://127.0.0.1:0/attachments'
process.env.ATTACHMENT_SIGNING_SECRET = 'blob-limits-test-secret'
process.env.ATTACHMENT_LOCAL_DIR = STORE_DIR
process.env.ATTACHMENT_MAX_FILE_SIZE_BYTES = String(MAX_BYTES)

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

function store() {
  return new LocalHmacObjectStore()
}

/** Count blob files (excluding .ct sidecars and .part temp files) under the store. */
function storedBlobCount(): number {
  let n = 0
  for (const shard of readdirSync(STORE_DIR, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue
    for (const f of readdirSync(join(STORE_DIR, shard.name))) {
      if (!f.endsWith('.ct') && !f.endsWith('.part')) n++
    }
  }
  return n
}

beforeAll(async () => {
  // Tiny rate-limit budget so the limiter is reachable in a few requests.
  const app = createApp({ rateLimit: { windowMs: 60_000, max: 3 } })
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

describe('attachment blob gateway upload bound (XIN-728)', () => {
  it('stores an upload at or below the size cap', async () => {
    const key = 'd_1/att_ok/small.png'
    const { uploadUrl, headers } = store().presignPut(key, 'image/png', 300)
    const body = Buffer.alloc(MAX_BYTES, 0x41) // exactly at the cap
    const res = await fetch(onLiveHost(uploadUrl), { method: 'PUT', headers, body })
    expect(res.status).toBe(200)
    expect((await res.json()).bytes).toBe(MAX_BYTES)
  })

  it('rejects an upload over the size cap with 413 and persists no object', async () => {
    const key = 'd_1/att_big/huge.png'
    const { uploadUrl, headers } = store().presignPut(key, 'image/png', 300)
    const before = storedBlobCount()
    const body = Buffer.alloc(MAX_BYTES + 4096, 0x42) // well past the cap
    const res = await fetch(onLiveHost(uploadUrl), { method: 'PUT', headers, body })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
    // The oversized body was aborted mid-stream: the GET must 404 (nothing
    // persisted at the key) and the total blob count must not have grown.
    const signed = store().presignGet(key, 300)
    const get = await fetch(onLiveHost(signed))
    expect(get.status).toBe(404)
    expect(storedBlobCount()).toBe(before)
  })
})

describe('attachment blob gateway rate limit (XIN-728)', () => {
  it('throttles a flood of signed blob GETs with 429', async () => {
    // The GET does not depend on prior state — an unknown key 404s — but each
    // request still passes through the limiter mounted ahead of the gateway.
    // With max=3 in the window (partly spent by the PUTs above), a short flood
    // must eventually be rejected 429 rather than every request reaching the
    // gateway.
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) {
      const signed = store().presignGet(`d_1/att_flood/x${i}.png`, 300)
      const res = await fetch(onLiveHost(signed))
      statuses.push(res.status)
    }
    expect(statuses).toContain(429)
  })
})
