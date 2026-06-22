import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the create-invite response shape. The link is built by
// the frontend from its own origin, so the backend must NOT return a Host-
// derived URL — only { inviteToken, role }. Mock the guard + invite repo and
// drive the route handler off the router stack (mirrors the pool/guard mocking
// in docsRoutes.test.ts / versions.test.ts).
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/repos/docInviteRepo.js', () => ({
  docInviteRepo: { create: vi.fn(async () => {}) },
}))

import { invitesRouter } from '../src/api/routes/invites.js'
import { requireDocRole } from '../src/api/guard.js'
import { docInviteRepo } from '../src/db/repos/docInviteRepo.js'

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

// Resolve the POST create-invite handler from the Express router stack.
function createInviteHandler() {
  for (const layer of (invitesRouter as unknown as { stack: any[] }).stack) {
    const route = layer.route
    if (route && route.path === '/:docId/invites' && route.methods?.post) {
      return route.stack[route.stack.length - 1].handle as (req: unknown, res: unknown) => Promise<void>
    }
  }
  throw new Error('create-invite handler not found')
}

// A request carrying Host / X-Forwarded-Proto headers — if the handler still
// built a URL from these, the leak would show up in the response.
function req() {
  return {
    uid: 'u_admin',
    params: { docId: 'd_1' },
    body: { role: 'writer' },
    protocol: 'http',
    header: (name: string) =>
      name.toLowerCase() === 'host'
        ? 'attacker.example.com'
        : name.toLowerCase() === 'x-forwarded-proto'
          ? 'https'
          : undefined,
  } as never
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(docInviteRepo.create).mockClear()
})

describe('POST /api/v1/docs/:docId/invites — create response (#6)', () => {
  it('returns only { inviteToken, role } with no host-derived url', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: {}, role: 'admin' } as never)
    const res = mockRes()
    await createInviteHandler()(req(), res as never)

    expect(res.statusCode).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(typeof body.inviteToken).toBe('string')
    expect(body.role).toBe('writer')

    // No host-derived link of any kind in the response.
    expect(body).not.toHaveProperty('url')
    expect(JSON.stringify(body)).not.toContain('attacker.example.com')
    expect(JSON.stringify(body)).not.toContain('http')
  })
})
