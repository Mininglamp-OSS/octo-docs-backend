import { describe, it, expect } from 'vitest'
import { validateAwarenessStates } from '../src/collab/server.js'
import type { AuthContext } from '../src/collab/authenticate.js'

function ctxFor(id: string): AuthContext {
  return {
    user: { id },
    role: 'writer',
    permission_epoch: 1,
    space: 's',
    folder: 'f',
    doc: 'd',
  }
}

function presence(id: string, name = 'Ada', color = '#aabbcc') {
  return { user: { id, name, color }, cursor: { anchor: 1, head: 1 } }
}

describe('awareness identity validation (§8.3.1, source-scoped & non-fatal)', () => {
  it("accepts a second concurrent user's own valid presence without throwing", () => {
    // beforeHandleAwareness hands us only THIS source connection's inbound
    // frame. A second authenticated user's update carries their own clientId +
    // their own id — it must validate against THEIR ctx and survive untouched,
    // so two tabs see each other's cursors and the process is never killed.
    const states = new Map<number, Record<string, unknown>>([[42, presence('user-2')]])

    expect(() => validateAwarenessStates(states, ctxFor('user-2'))).not.toThrow()
    expect(states.has(42)).toBe(true)
    expect(states.get(42)).toEqual(presence('user-2'))
    expect(states.size).toBe(1)
  })

  it('does not throw and preserves valid states even with a server-internal (no ctx) update', () => {
    const states = new Map<number, Record<string, unknown>>([[7, presence('user-1')]])
    expect(() => validateAwarenessStates(states, undefined)).not.toThrow()
    expect(states.has(7)).toBe(true)
  })

  it('drops an impostor frame (user.id != source ctx) without throwing, keeping valid states', () => {
    // The source connection belongs to user-1 but crafts a frame claiming to be
    // user-victim. That entry is dropped; the connection's own valid entry stays.
    const states = new Map<number, Record<string, unknown>>([
      [1, presence('user-1')],
      [99, presence('user-victim')],
    ])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true)
    expect(states.has(99)).toBe(false)
    expect(states.size).toBe(1)
  })

  it('relays whiteboard presence that carries no color field (id + name + avatar)', () => {
    // The v1 whiteboard binding publishes { id, name, avatar } with NO color.
    // A missing color must NOT drop the state — otherwise the receiving peer
    // gets zero awareness frames (presence A->B = 0). The state survives intact.
    const wb = { user: { id: 'user-1', name: 'Ada', avatar: 'https://x/a.png' }, pointer: { x: 1, y: 2 } }
    const states = new Map<number, Record<string, unknown>>([[5, wb]])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(5)).toBe(true)
    expect(states.get(5)).toEqual(wb) // untouched: id, name, avatar, pointer all preserved
  })

  it('strips an invalid color (CSS-injection guard) but KEEPS the presence state', () => {
    // An invalid/unsafe color is sanitized in place — the dangerous value never
    // propagates, but the user's presence still broadcasts (the rest survives).
    const states = new Map<number, Record<string, unknown>>([
      [1, presence('user-1', 'Ada', '#aabbcc')],
      [2, { user: { id: 'user-1', name: 'Eve', color: 'red; background:url(x)' }, cursor: { anchor: 1, head: 1 } }],
    ])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true)
    expect(states.get(1)).toEqual(presence('user-1')) // valid color preserved
    expect(states.has(2)).toBe(true) // state kept (not dropped)
    const u2 = (states.get(2) as { user: Record<string, unknown> }).user
    expect('color' in u2).toBe(false) // unsafe color stripped
    expect(u2.name).toBe('Eve') // rest of presence preserved
  })

  it('strips a non-string or oversized name but KEEPS the presence state', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, presence('user-1', 'x'.repeat(64))],
      [2, presence('user-1', 'x'.repeat(65))],
      [3, { user: { id: 'user-1', name: 123, color: '#aabbcc' } }],
    ])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true) // 64 chars is allowed, preserved
    expect((states.get(1) as { user: Record<string, unknown> }).user.name).toBe('x'.repeat(64))
    expect(states.has(2)).toBe(true) // state kept
    expect('name' in (states.get(2) as { user: Record<string, unknown> }).user).toBe(false) // 65-char name stripped
    expect(states.has(3)).toBe(true) // state kept
    const u3 = (states.get(3) as { user: Record<string, unknown> }).user
    expect('name' in u3).toBe(false) // non-string name stripped
    expect(u3.color).toBe('#aabbcc') // valid color preserved
  })

  it('leaves non-presence awareness data (no user field) untouched', () => {
    const states = new Map<number, Record<string, unknown>>([[1, { cursor: { anchor: 0, head: 0 } }]])
    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true)
  })
})

describe('awareness avatar sanitization (P2 XSS guard, non-fatal)', () => {
  const keepAvatar = (avatar: unknown) => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { id: 'user-1', name: 'Ada', avatar } }],
    ])
    validateAwarenessStates(states, ctxFor('user-1'))
    const u = (states.get(1) as { user: Record<string, unknown> }).user
    return { present: 'avatar' in u, value: u.avatar, name: u.name }
  }

  it('preserves safe avatar references (http/https, protocol- & root-relative, raster data URI)', () => {
    for (const safe of [
      'https://cdn.example.com/a.png',
      'http://example.com/a.jpg',
      '//cdn.example.com/a.webp', // protocol-relative
      '/avatars/user-1.png', // root-relative
      'avatars/user-1.gif', // relative path
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    ]) {
      const r = keepAvatar(safe)
      expect(r.present, safe).toBe(true)
      expect(r.value, safe).toBe(safe)
    }
  })

  it('strips a script-vector avatar (javascript:/data:text/html) but KEEPS presence', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const r = keepAvatar(bad)
      expect(r.present, bad).toBe(false) // dangerous value stripped
      expect(r.name, bad).toBe('Ada') // rest of presence survives
    }
  })

  it('strips an svg data URI (SVG can embed script) and any value with markup/control chars', () => {
    expect(keepAvatar('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').present).toBe(false)
    expect(keepAvatar('https://x/a.png"><img src=x onerror=alert(1)>').present).toBe(false)
    expect(keepAvatar('vbscript:msgbox(1)').present).toBe(false)
    expect(keepAvatar('file:///etc/passwd').present).toBe(false)
  })

  it('strips a non-string or oversize avatar', () => {
    expect(keepAvatar(12345).present).toBe(false)
    expect(keepAvatar({ url: 'x' }).present).toBe(false)
    expect(keepAvatar('https://x/' + 'a'.repeat(2100)).present).toBe(false) // > AVATAR_MAX_LEN
  })
})
