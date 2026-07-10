import { describe, it, expect } from 'vitest'
import { LocalHmacObjectStore } from '../src/storage/objectStore.js'

// Deterministic clock so expiry assertions are stable.
function storeAt(now: number, secret = 'test-secret') {
  return new LocalHmacObjectStore({ bucket: 'test-bucket', secret, nowSec: () => now })
}

describe('LocalHmacObjectStore presign driver (§3.5)', () => {
  it('mints a PUT url that verifies and carries the Content-Type header', () => {
    const store = storeAt(1000)
    const { uploadUrl, headers } = store.presignPut('d_1/att_1/photo.png', 'image/png', 300)
    expect(uploadUrl).toContain('X-Signature=')
    expect(headers).toEqual({ 'Content-Type': 'image/png' })
    expect(store.verify(uploadUrl).valid).toBe(true)
  })

  it('applies a key prefix to the path and still verifies round-trip', () => {
    const store = new LocalHmacObjectStore({
      bucket: 'test-bucket',
      secret: 'test-secret',
      keyPrefix: 'octo-docs-local-dev',
      nowSec: () => 1000,
    })
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    expect(new URL(url).pathname).toBe('/octo-docs-local-dev/d_1/att_1/photo.png')
    // The signature covers the prefixed key, so verification is self-consistent.
    expect(store.verify(url).valid).toBe(true)
    // Tampering with the prefixed path invalidates the signature.
    const tampered = url.replace('/octo-docs-local-dev/', '/octo-docs-local-dev-evil/')
    expect(store.verify(tampered).valid).toBe(false)
  })

  it('mints a GET url that verifies', () => {
    const store = storeAt(1000)
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    expect(store.verify(url).valid).toBe(true)
  })

  it('fails verification once the url has expired', () => {
    const minted = storeAt(1000)
    const url = minted.presignGet('d_1/att_1/photo.png', 300) // expiry = 1300

    // A verifier whose clock is past the expiry rejects it.
    const later = storeAt(1301)
    const result = later.verify(url)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('rejects a tampered object key', () => {
    const store = storeAt(1000)
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    // Swap the key in the path; the signature no longer matches.
    const tampered = url.replace('photo.png', 'evil.png')
    const result = store.verify(tampered)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('bad_signature')
  })

  it('rejects a tampered signature', () => {
    const store = storeAt(1000)
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    const u = new URL(url)
    u.searchParams.set('X-Signature', 'deadbeef')
    const result = store.verify(u.toString())
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('bad_signature')
  })

  it('rejects a url signed with a different secret', () => {
    const url = storeAt(1000, 'secret-a').presignGet('d_1/att_1/photo.png', 600)
    const result = storeAt(1000, 'secret-b').verify(url)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('bad_signature')
  })

  it('does not let a GET signature be replayed as a PUT', () => {
    const store = storeAt(1000)
    const getUrl = store.presignGet('d_1/att_1/photo.png', 600)
    const asPut = getUrl.replace('X-Method=GET', 'X-Method=PUT')
    expect(store.verify(asPut).valid).toBe(false)
  })

  it('carries a content-disposition param that is bound into the signature', () => {
    const store = storeAt(1000)
    const disp = 'attachment; filename="report.zip"'
    const url = store.presignGet('d_1/att_1/report.zip', 600, { contentDisposition: disp })
    expect(new URL(url).searchParams.get('response-content-disposition')).toBe(disp)
    expect(store.verify(url).valid).toBe(true)
  })

  it('rejects a url whose content-disposition was tampered after signing', () => {
    const store = storeAt(1000)
    const url = store.presignGet('d_1/att_1/report.zip', 600, {
      contentDisposition: 'attachment; filename="report.zip"',
    })
    const u = new URL(url)
    u.searchParams.set('response-content-disposition', 'inline')
    expect(store.verify(u.toString()).valid).toBe(false)
    expect(store.verify(u.toString()).reason).toBe('bad_signature')
  })

  it('keeps the legacy (no-disposition) GET signature unchanged', () => {
    // A GET without a disposition must verify exactly as before — the extra
    // signing material is only appended when a disposition is present.
    const store = storeAt(1000)
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    expect(new URL(url).searchParams.has('response-content-disposition')).toBe(false)
    expect(store.verify(url).valid).toBe(true)
  })

  it('falls back to the internal object-store.local host when no public base URL is set', () => {
    // Documents the legacy default so the regression below is unambiguous: with
    // no ATTACHMENT_PUBLIC_BASE_URL the driver still signs the unreachable alias.
    const store = storeAt(1000)
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)
    expect(url.host).toBe('test-bucket.object-store.local')
  })
})

// XIN-713: the presigned PUT/GET URL host must be a host the end-user browser
// can actually resolve. The historical default baked `object-store.local` into
// every signed URL — an internal alias that fails with ERR_NAME_NOT_RESOLVED in
// the browser, so the direct PUT never lands and collaborators see no image.
// ATTACHMENT_PUBLIC_BASE_URL routes the signed URL through a reachable origin
// (e.g. the docs-backend that fronts object storage) without hardcoding it.
describe('LocalHmacObjectStore public base URL (XIN-713)', () => {
  function storeWithBase(baseUrl: string, now = 1000) {
    return new LocalHmacObjectStore({
      bucket: 'test-bucket',
      secret: 'test-secret',
      publicBaseUrl: baseUrl,
      nowSec: () => now,
    })
  }

  it('signs the PUT url against the configured public host, not the internal alias', () => {
    const store = storeWithBase('http://192.168.214.189:8092')
    const { uploadUrl } = store.presignPut('d_1/att_1/photo.png', 'image/png', 300)
    const url = new URL(uploadUrl)

    // Host is the configured, browser-reachable origin.
    expect(url.host).toBe('192.168.214.189:8092')
    expect(url.protocol).toBe('http:')
    // The dead internal alias is gone.
    expect(uploadUrl).not.toContain('object-store.local')
    // Path is the plain object key; the URL still verifies round-trip.
    expect(url.pathname).toBe('/d_1/att_1/photo.png')
    expect(store.verify(uploadUrl).valid).toBe(true)
  })

  it('signs the GET url against the configured public host and round-trips', () => {
    const store = storeWithBase('http://192.168.214.189:8092')
    const signed = store.presignGet('d_1/att_1/photo.png', 600)
    const url = new URL(signed)
    expect(url.host).toBe('192.168.214.189:8092')
    expect(signed).not.toContain('object-store.local')
    expect(store.verify(signed).valid).toBe(true)
  })

  it('tolerates a trailing slash on the base URL', () => {
    const store = storeWithBase('http://192.168.214.189:8092/')
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)
    expect(url.host).toBe('192.168.214.189:8092')
    // No doubled slash before the key.
    expect(url.pathname).toBe('/d_1/att_1/photo.png')
  })

  it('supports a base URL that carries a path segment and still verifies', () => {
    // Mounting the attachment host under a path (e.g. behind the backend origin)
    // must not change the signed key: the path prefix is stripped before verify.
    const store = storeWithBase('http://docs-backend:8092/attachments')
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    const parsed = new URL(url)
    expect(parsed.host).toBe('docs-backend:8092')
    expect(parsed.pathname).toBe('/attachments/d_1/att_1/photo.png')
    expect(store.verify(url).valid).toBe(true)
  })

  it('carries the key prefix through the public base URL and verifies round-trip', () => {
    const store = new LocalHmacObjectStore({
      bucket: 'test-bucket',
      secret: 'test-secret',
      keyPrefix: 'octo-docs-local-dev',
      publicBaseUrl: 'http://192.168.214.189:8092',
      nowSec: () => 1000,
    })
    const url = store.presignGet('d_1/att_1/photo.png', 600)
    const parsed = new URL(url)
    expect(parsed.host).toBe('192.168.214.189:8092')
    expect(parsed.pathname).toBe('/octo-docs-local-dev/d_1/att_1/photo.png')
    expect(store.verify(url).valid).toBe(true)
  })

  it('honours an https public base URL host and protocol', () => {
    const store = storeWithBase('https://docs.example.com')
    const url = new URL(store.presignPut('d_1/att_1/photo.png', 'image/png', 300).uploadUrl)
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('docs.example.com')
    expect(url.toString()).not.toContain('object-store.local')
  })
})
