import { describe, it, expect } from 'vitest'
import { buildDocShareUrl } from '../src/util/docShareLink.js'

// buildDocShareUrl mints the canonical, browser-facing doc share link a caller
// (bot via octo-cli, OpenClaw octo plugin, any integration) can pass straight to
// chat. It must mirror octo-web's authoritative buildDocLink byte-for-byte for
// the same (docId, spaceId):
//   <web-origin>/d/<docId>?sp=<spaceId>
// The docId lives in the PATH (a `/docs?doc=` query is stripped by the octo
// host's RouteManager, which is what produced broken links); ?sp carries the
// doc's real space so the recipient preflight addresses the doc's own space;
// and it must NEVER emit ?sid.

describe('buildDocShareUrl (canonical doc share link)', () => {
  const WEB = 'http://192.168.214.189:3010'

  it('builds <origin>/d/<docId>?sp=<spaceId> with a space', () => {
    expect(buildDocShareUrl(WEB, 'd_abc123', 's_space1')).toBe(
      'http://192.168.214.189:3010/d/d_abc123?sp=s_space1',
    )
  })

  it('omits the ?sp query when no space is given', () => {
    expect(buildDocShareUrl(WEB, 'd_abc123')).toBe('http://192.168.214.189:3010/d/d_abc123')
    expect(buildDocShareUrl(WEB, 'd_abc123', '')).toBe('http://192.168.214.189:3010/d/d_abc123')
  })

  it('URL-encodes the docId and spaceId', () => {
    expect(buildDocShareUrl(WEB, 'd_a b/c', 's p&x')).toBe(
      'http://192.168.214.189:3010/d/d_a%20b%2Fc?sp=s%20p%26x',
    )
  })

  it('degrades to an origin-relative path-only form when webOrigin is empty', () => {
    expect(buildDocShareUrl('', 'd_abc123', 's_space1')).toBe('/d/d_abc123?sp=s_space1')
    expect(buildDocShareUrl('   ', 'd_abc123', 's_space1')).toBe('/d/d_abc123?sp=s_space1')
    expect(buildDocShareUrl('', 'd_abc123')).toBe('/d/d_abc123')
  })

  it('strips a trailing slash on the origin so the path is not doubled', () => {
    expect(buildDocShareUrl('http://web.example.com/', 'd_abc123', 's_space1')).toBe(
      'http://web.example.com/d/d_abc123?sp=s_space1',
    )
    expect(buildDocShareUrl('http://web.example.com///', 'd_abc123')).toBe(
      'http://web.example.com/d/d_abc123',
    )
  })

  it('never emits a ?sid query', () => {
    expect(buildDocShareUrl(WEB, 'd_abc123', 's_space1')).not.toContain('sid=')
    expect(buildDocShareUrl(WEB, 'd_abc123')).not.toContain('sid=')
    expect(buildDocShareUrl('', 'd_abc123', 's_space1')).not.toContain('sid=')
  })
})
