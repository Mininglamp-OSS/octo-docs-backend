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
})
