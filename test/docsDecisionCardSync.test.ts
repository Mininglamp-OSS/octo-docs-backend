import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Offline unit tests for the access-decision card-sync service (task
// docs-access-decision-card-sync). config, docAccessNotifyCardRepo and
// global.fetch are mocked so we assert, without any DB or octo-server:
//   - config gating (missing internal token => no-op, no fetch)
//   - empty ledger => early return, no HTTP
//   - card-callback path (deciderCardHandledExternally:true) skips the decider's
//     own card; REST path (omitted/false) terminalizes the decider's card too
//   - happy path: every sibling mutated in place, each marked terminalized
//   - mutate failure => re-notify fallback for that card
//   - best-effort: a repo/HTTP failure never throws out of syncDecisionCards
vi.mock('../src/config/env.js', () => ({
  config: {
    octoIdentity: { serverBaseUrl: 'http://octo-server:8080' },
    notify: { docsToken: '', service: 'docs-service' },
  },
}))
vi.mock('../src/db/repos/docAccessNotifyCardRepo.js', () => ({
  NOTIFY_CARD_STATUS_ACTIVE: 1,
  NOTIFY_CARD_STATUS_TERMINALIZED: 2,
  docAccessNotifyCardRepo: {
    listByRequest: vi.fn(async () => []),
    markTerminalized: vi.fn(async () => {}),
  },
}))

import { syncDecisionCards } from '../src/api/services/docsDecisionCardSync.js'
import { config } from '../src/config/env.js'
import { docAccessNotifyCardRepo } from '../src/db/repos/docAccessNotifyCardRepo.js'

const cfg = config as unknown as { notify: { docsToken: string; service: string } }
const repo = docAccessNotifyCardRepo as unknown as {
  listByRequest: ReturnType<typeof vi.fn>
  markTerminalized: ReturnType<typeof vi.fn>
}

function row(recipientUid: string) {
  return {
    request_id: 'req-1',
    recipient_uid: recipientUid,
    channel_id: `ch-${recipientUid}`,
    channel_type: 1,
    message_id: `m-${recipientUid}`,
    client_msg_no: '',
    status: 1,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

function baseParams() {
  return {
    requestId: 'req-1',
    spaceId: 'space-1',
    docId: 'doc-1',
    title: 'Test Doc',
    deciderUid: 'u-owner',
    denied: false,
  }
}

/** Parse the JSON body of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, i: number): Record<string, string> {
  return JSON.parse(fetchMock.mock.calls[i][1].body as string) as Record<string, string>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  cfg.notify.docsToken = 'internal-token'
  repo.listByRequest.mockReset().mockResolvedValue([])
  repo.markTerminalized.mockReset().mockResolvedValue(undefined)
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('syncDecisionCards', () => {
  it('is a no-op when the internal token is not configured', async () => {
    cfg.notify.docsToken = ''
    await syncDecisionCards(baseParams())
    expect(repo.listByRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns early with no HTTP when the ledger is empty', async () => {
    repo.listByRequest.mockResolvedValue([])
    await syncDecisionCards(baseParams())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('card-callback path skips the decider own card (finalizer handled it)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-owner'), row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderUid: 'u-owner', deciderCardHandledExternally: true })
    // Only the two non-decider siblings are mutated.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const targets = [bodyOf(fetchMock, 0).message_id, bodyOf(fetchMock, 1).message_id].sort()
    expect(targets).toEqual(['m-u-admin1', 'm-u-admin2'])
  })

  it('REST path terminalizes the decider own card too (no finalizer)', async () => {
    repo.listByRequest.mockResolvedValue([row('u-owner'), row('u-admin1'), row('u-admin2')])
    // deciderCardHandledExternally omitted => REST path
    await syncDecisionCards({ ...baseParams(), deciderUid: 'u-owner' })
    // All three cards, INCLUDING the decider's own, are mutated.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const targets = [
      bodyOf(fetchMock, 0).message_id,
      bodyOf(fetchMock, 1).message_id,
      bodyOf(fetchMock, 2).message_id,
    ].sort()
    expect(targets).toEqual(['m-u-admin1', 'm-u-admin2', 'm-u-owner'])
  })

  it('happy path mutates in place and marks each card terminalized', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1'), row('u-admin2')])
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    // All calls hit the in-place mutate endpoint (not the re-notify fallback).
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toContain('/v1/internal/cards/mutate')
      expect(call[1].headers['X-Internal-Token']).toBe('internal-token')
    }
    expect(repo.markTerminalized).toHaveBeenCalledTimes(2)
  })

  it('falls back to a fresh terminal card when a mutate fails', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/internal/cards/mutate')) return { ok: false, status: 500 }
      return { ok: true, status: 200 }
    })
    await syncDecisionCards({ ...baseParams(), deciderCardHandledExternally: true })
    const paths = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(paths.some((p) => p.includes('/v1/internal/cards/mutate'))).toBe(true)
    expect(paths.some((p) => p.includes('/v1/internal/notify'))).toBe(true)
    // A failed mutate must NOT be audited as terminalized.
    expect(repo.markTerminalized).not.toHaveBeenCalled()
  })

  it('carries the deny reason onto the terminal card when denied', async () => {
    repo.listByRequest.mockResolvedValue([row('u-admin1')])
    await syncDecisionCards({
      ...baseParams(),
      denied: true,
      denyReason: '权限不足',
      deciderCardHandledExternally: true,
    })
    expect(bodyOf(fetchMock, 0).deny_reason).toBe('权限不足')
  })

  it('never throws even when the ledger lookup fails (best-effort)', async () => {
    repo.listByRequest.mockRejectedValue(new Error('db down'))
    await expect(syncDecisionCards(baseParams())).resolves.toBeUndefined()
  })
})
