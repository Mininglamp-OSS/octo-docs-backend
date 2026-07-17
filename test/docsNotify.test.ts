import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the docs-notify outbound client (octo-server internal
// notify API, PR #584 contract). config, docMemberRepo, octoIdentity and
// global.fetch are mocked so we assert:
//   - config gating (missing internal token => no-op, no fetch)
//   - recipient resolution (owner + admins, de-duped, requester excluded)
//   - request shape: /v1/internal/notify, X-Internal-Token header, single-target
//     docs_card{kind:access_requested, ...} — and NEVER a type-17 payload/card
//   - only delivered[] counts; filtered/500/network failures are swallowed
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
  },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  ROLE_ADMIN: 3,
  docMemberRepo: { list: vi.fn(async () => []) },
}))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUser: vi.fn(async () => ({ uid: 'u-req', name: '申请人小明' })) }),
}))

import { notifyDocAccessRequested } from '../src/api/services/docsNotify.js'
import { config } from '../src/config/env.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

const cfg = config as unknown as { notify: { docsToken: string; service: string } }

function baseParams() {
  return {
    docId: 'doc-1',
    requestId: 'req-1',
    spaceId: 'space-1',
    ownerId: 'u-owner',
    title: 'Test Doc',
    requesterUid: 'u-req',
    reason: 'need edit',
  }
}

function okResp(delivered: string[]) {
  return new Response(JSON.stringify({ delivered, filtered: {} }), { status: 200 })
}

describe('notifyDocAccessRequested', () => {
  beforeEach(() => {
    cfg.notify.docsToken = 'internal-token'
    ;(docMemberRepo.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { doc_id: 'doc-1', uid: 'u-admin', role: 3 },
      { doc_id: 'doc-1', uid: 'u-writer', role: 2 }, // not admin -> excluded
      { doc_id: 'doc-1', uid: 'u-owner', role: 3 }, // duplicate of owner -> de-duped
    ])
    // Echo the single target back in delivered[] so each send counts as delivered.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const uid = JSON.parse(init.body as string).targets[0]
        return okResp([uid])
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is a no-op when the internal token is unset (no fetch)', async () => {
    cfg.notify.docsToken = ''
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends to owner + admins, de-duped, excluding the requester (one request each)', async () => {
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(2)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    const recipients = calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).targets[0]).sort()
    expect(recipients).toEqual(['u-admin', 'u-owner'])
  })

  it('hits /v1/internal/notify with X-Internal-Token and a single-target docs_card', async () => {
    await notifyDocAccessRequested(baseParams())
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://octo-server:8080/v1/internal/notify')
    expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('internal-token')
    const body = JSON.parse(init.body as string)
    expect(body.space_id).toBe('space-1')
    expect(body.service).toBe('docs-service')
    expect(body.targets).toHaveLength(1)
    // Never a hand-built type-17 map — only structured docs_card.
    expect(body.payload).toBeUndefined()
    expect(body.card).toBeUndefined()
    expect(body.docs_card.kind).toBe('access_requested')
    expect(body.docs_card.doc_id).toBe('doc-1')
    expect(body.docs_card.title).toBe('Test Doc')
    expect(body.docs_card.actor_name).toBe('申请人小明')
    expect(body.docs_card.excerpt).toBe('need edit')
    expect(typeof body.docs_card.updated_at).toBe('string')
  })

  it('counts only delivered[]; a filtered recipient is not counted', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okResp(['u-owner'])) // delivered
        .mockResolvedValueOnce(new Response(JSON.stringify({ delivered: [], filtered: { 'u-admin': 'busy' } }), { status: 200 })),
    )
    const delivered = await notifyDocAccessRequested(baseParams())
    expect(delivered).toBe(1)
  })

  it('never throws on a 500 or network error (best-effort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await notifyDocAccessRequested(baseParams())).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await notifyDocAccessRequested(baseParams())).toBe(0)
  })
})
