import { describe, it, expect, vi } from 'vitest'

// Unit tests for the space-context middleware (strict by-space isolation, P1).
// The isolation boundary is the frontend-injected X-Space-Id header: present and
// non-empty -> stash the trimmed value on req.spaceId and continue; missing or
// empty -> hard 400 (no warn/grace mode).
import { spaceContextMiddleware } from '../src/api/middleware/spaceContext.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

// A request whose header(name) resolves the given case-insensitive header map,
// mirroring Express's req.header().
function req(headers: Record<string, string | undefined>) {
  const lower: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    spaceId: undefined as string | undefined,
    header(name: string) {
      return lower[name.toLowerCase()]
    },
  } as never
}

describe('spaceContextMiddleware — X-Space-Id required (§ by-space isolation P1)', () => {
  it('populates req.spaceId and calls next when the header is present', () => {
    const r = req({ 'X-Space-Id': 's_42' })
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_42')
    expect(res.statusCode).toBe(0) // no response written on the happy path
  })

  it('trims surrounding whitespace from the header value', () => {
    const r = req({ 'X-Space-Id': '  s_trim  ' })
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((r as unknown as { spaceId?: string }).spaceId).toBe('s_trim')
  })

  it('rejects a missing header with 400 space_required and does not call next', () => {
    const r = req({})
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
    expect((r as unknown as { spaceId?: string }).spaceId).toBeUndefined()
  })

  it('rejects an empty header with 400 space_required', () => {
    const r = req({ 'X-Space-Id': '' })
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only header with 400 space_required', () => {
    const r = req({ 'X-Space-Id': '   ' })
    const res = mockRes()
    const next = vi.fn()

    spaceContextMiddleware(r, res as never, next)

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'space_required' })
    expect(next).not.toHaveBeenCalled()
  })
})
