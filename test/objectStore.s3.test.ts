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
