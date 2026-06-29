import { describe, it, expect } from 'vitest'
import { S3ObjectStore } from '../src/storage/objectStore.js'

// Deterministic clock so the embedded X-Amz-Date (and thus the signature) is
// stable across runs.
function storeAt(now: number) {
  return new S3ObjectStore({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'octo-docs-attachments',
    accessKeyId: 'minio',
    secretAccessKey: 'test-secret-key',
    nowSec: () => now,
  })
}

describe('S3ObjectStore SigV4 presign driver (§3.5)', () => {
  it('signs a PUT url against the public endpoint host, path-style', () => {
    const store = storeAt(1_700_000_000)
    const { uploadUrl, headers } = store.presignPut('d_1/att_1/photo.png', 'image/png', 300)
    const url = new URL(uploadUrl)

    // Host is the configured public endpoint, never the dead docker alias.
    expect(url.host).toBe('localhost:9000')
    expect(uploadUrl).not.toContain('object-store.local')

    // Path-style: /<bucket>/<key>.
    expect(url.pathname).toBe('/octo-docs-attachments/d_1/att_1/photo.png')

    // SigV4 query params present.
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-Credential')).toContain('minio/')

    // Content-Type is handed back for the client to echo but is not a signed header.
    expect(headers).toEqual({ 'Content-Type': 'image/png' })
  })

  it('signs a GET url against the public endpoint host', () => {
    const store = storeAt(1_700_000_000)
    const signed = store.presignGet('d_1/att_1/photo.png', 600)
    const url = new URL(signed)

    expect(url.host).toBe('localhost:9000')
    expect(url.pathname).toBe('/octo-docs-attachments/d_1/att_1/photo.png')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(signed).not.toContain('object-store.local')
  })

  it('honours the configured X-Amz-Expires value', () => {
    const store = storeAt(1_700_000_000)
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 42).uploadUrl)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('42')
  })

  it('is deterministic for a fixed clock (same inputs → identical signature)', () => {
    const a = storeAt(1_700_000_000).presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl
    const b = storeAt(1_700_000_000).presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl
    expect(a).toBe(b)
  })

  it('binds the signature to the HTTP method (PUT and GET differ)', () => {
    const store = storeAt(1_700_000_000)
    const put = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)
    const get = new URL(store.presignGet('d_1/att_1/photo.png', 300))
    expect(put.searchParams.get('X-Amz-Signature')).not.toBe(
      get.searchParams.get('X-Amz-Signature'),
    )
  })

  it('encodes a public endpoint with a custom host without leaking the dead alias', () => {
    const store = new S3ObjectStore({
      endpoint: 'https://cdn.example.com',
      region: 'us-east-1',
      bucket: 'octo-docs-attachments',
      accessKeyId: 'minio',
      secretAccessKey: 'test-secret-key',
      nowSec: () => 1_700_000_000,
    })
    const url = new URL(store.presignGet('d_1/att_1/photo.png', 600))
    expect(url.host).toBe('cdn.example.com')
    expect(url.protocol).toBe('https:')
  })

  it('signs response-content-disposition into the canonical query for non-inline reads', () => {
    const store = storeAt(1_700_000_000)
    const disp = 'attachment; filename="report.zip"'
    const url = new URL(store.presignGet('d_1/att_1/report.zip', 600, { contentDisposition: disp }))
    // S3/MinIO replays this query param as the response Content-Disposition; it
    // must be present and part of the signed (SignedHeaders=host) request.
    expect(url.searchParams.get('response-content-disposition')).toBe(disp)
    // Adding a signed query param changes the signature vs the plain GET.
    const plain = new URL(store.presignGet('d_1/att_1/report.zip', 600))
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(
      plain.searchParams.get('X-Amz-Signature'),
    )
  })
})

// Virtual-hosted / custom-domain addressing (forcePathStyle:false) is what
// Tencent COS behind a CDN domain needs: the host is already bound to the
// bucket, so the path (and the SigV4 canonicalUri) must NOT carry the bucket
// segment, or COS rejects the signature (403 SignatureDoesNotMatch).
function cosStoreAt(now: number, extra?: { keyPrefix?: string }) {
  return new S3ObjectStore({
    endpoint: 'https://cdn.deepminer.com.cn',
    region: 'ap-beijing',
    bucket: 'im-data-1255521909',
    accessKeyId: 'AKIDtest',
    secretAccessKey: 'test-secret-key',
    forcePathStyle: false,
    keyPrefix: extra?.keyPrefix,
    nowSec: () => now,
  })
}

describe('S3ObjectStore custom-domain / virtual-hosted addressing (COS)', () => {
  it('omits the bucket segment from the path and signs against the custom host', () => {
    const store = cosStoreAt(1_700_000_000)
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)

    // Host is the custom CDN domain, already mapped to the bucket.
    expect(url.host).toBe('cdn.deepminer.com.cn')
    expect(url.protocol).toBe('https:')
    // Path-style would be /im-data-1255521909/d_1/...; virtual-hosted drops it.
    expect(url.pathname).toBe('/d_1/att_1/photo.png')
    expect(url.pathname).not.toContain('im-data-1255521909')

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    // Region flows into the credential scope (service stays s3 for COS).
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/ap-beijing/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('GET also omits the bucket and stays on the custom host', () => {
    const store = cosStoreAt(1_700_000_000)
    const url = new URL(store.presignGet('d_1/att_1/photo.png', 600))
    expect(url.host).toBe('cdn.deepminer.com.cn')
    expect(url.pathname).toBe('/d_1/att_1/photo.png')
    expect(url.pathname).not.toContain('im-data-1255521909')
  })

  it('applies ATTACHMENT_KEY_PREFIX to the signed key (path carries the prefix)', () => {
    const store = cosStoreAt(1_700_000_000, { keyPrefix: 'octo-docs-local-dev' })
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)
    expect(url.pathname).toBe('/octo-docs-local-dev/d_1/att_1/photo.png')
    // Still no bucket segment in virtual-hosted mode.
    expect(url.pathname).not.toContain('im-data-1255521909')
  })

  it('normalises stray slashes on the prefix', () => {
    const store = cosStoreAt(1_700_000_000, { keyPrefix: '/octo-docs-local-dev/' })
    const url = new URL(store.presignGet('d_1/att_1/photo.png', 600))
    expect(url.pathname).toBe('/octo-docs-local-dev/d_1/att_1/photo.png')
  })

  it('prefix participates in the signature (different prefix → different signature)', () => {
    const withPrefix = new URL(
      cosStoreAt(1_700_000_000, { keyPrefix: 'octo-docs-local-dev' }).presignGet(
        'd_1/att_1/photo.png',
        600,
      ),
    )
    const noPrefix = new URL(cosStoreAt(1_700_000_000).presignGet('d_1/att_1/photo.png', 600))
    expect(withPrefix.searchParams.get('X-Amz-Signature')).not.toBe(
      noPrefix.searchParams.get('X-Amz-Signature'),
    )
  })

  it('is deterministic for a fixed clock (same inputs → identical signature)', () => {
    const a = cosStoreAt(1_700_000_000, { keyPrefix: 'p' }).presignPut(
      'd_1/att_1/photo.png',
      'image/png',
      300,
    ).uploadUrl
    const b = cosStoreAt(1_700_000_000, { keyPrefix: 'p' }).presignPut(
      'd_1/att_1/photo.png',
      'image/png',
      300,
    ).uploadUrl
    expect(a).toBe(b)
  })

  it('path-style mode still carries the bucket and also honours the prefix', () => {
    const store = new S3ObjectStore({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'octo-docs-attachments',
      accessKeyId: 'minio',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: true,
      keyPrefix: 'octo-docs-local-dev',
      nowSec: () => 1_700_000_000,
    })
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)
    expect(url.pathname).toBe('/octo-docs-attachments/octo-docs-local-dev/d_1/att_1/photo.png')
  })

  it('defaults to path-style when forcePathStyle is omitted (MinIO back-compat)', () => {
    const store = new S3ObjectStore({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'octo-docs-attachments',
      accessKeyId: 'minio',
      secretAccessKey: 'test-secret-key',
      nowSec: () => 1_700_000_000,
    })
    const url = new URL(store.presignGet('d_1/att_1/photo.png', 600))
    expect(url.pathname).toBe('/octo-docs-attachments/d_1/att_1/photo.png')
  })

  it('signs against signingHost (CDN origin-pull) while the URL keeps the custom host', () => {
    const origin = 'im-data-1255521909.cos.ap-beijing.myqcloud.com'
    const withSigningHost = new S3ObjectStore({
      endpoint: 'https://cdn.deepminer.com.cn',
      region: 'ap-beijing',
      bucket: 'im-data-1255521909',
      accessKeyId: 'AKIDtest',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: false,
      signingHost: origin,
      nowSec: () => 1_700_000_000,
    })
    const url = new URL(withSigningHost.presignGet('d_1/att_1/photo.png', 600))
    // The browser-facing URL still targets the custom CDN domain...
    expect(url.host).toBe('cdn.deepminer.com.cn')
    // ...and the host:port the CDN forwards to COS is never leaked into the URL.
    expect(url.toString()).not.toContain(origin)

    // The signed `host` header is the origin, so the signature differs from the
    // one we'd produce signing the custom host (the bug COS rejected as 403).
    const noSigningHost = new S3ObjectStore({
      endpoint: 'https://cdn.deepminer.com.cn',
      region: 'ap-beijing',
      bucket: 'im-data-1255521909',
      accessKeyId: 'AKIDtest',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: false,
      nowSec: () => 1_700_000_000,
    })
    const plain = new URL(noSigningHost.presignGet('d_1/att_1/photo.png', 600))
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(
      plain.searchParams.get('X-Amz-Signature'),
    )
  })
})
