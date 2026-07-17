import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for docAccessRequestRepo.submit — request_id ROTATION on
// re-submit (review blocker: stale-card cross-approval).
//
// An approval card carries only request_id as its decision key. If a re-submit
// reused the same request_id, a stale card minted for an earlier submission
// (e.g. requested "reader") could approve a LATER, different pending row (e.g.
// re-submitted as "writer") — granting a role the approver never saw on their
// card. submit() must therefore write `request_id = VALUES(request_id)` in the
// ON DUPLICATE KEY UPDATE so every submission rotates to a fresh id; a stale
// card's request_id then matches no row and the callback resolves not_found.
//
// We mock the pool's `query` so the SQL + bind order are asserted and the
// read-back-authoritative-row contract is locked without a DB.
const query = vi.fn()
vi.mock('../src/db/pool.js', () => ({
  query: (...args: unknown[]) => query(...args),
  getPool: () => ({ execute: vi.fn() }),
}))
// Deterministic id so we can assert it flows into the INSERT bind AND the update.
vi.mock('../src/util/ids.js', () => ({ newRequestId: () => 'rotated-id-2' }))

import { docAccessRequestRepo, REQUEST_STATUS_PENDING } from '../src/db/repos/docAccessRequestRepo.js'

beforeEach(() => {
  query.mockReset()
})

const params = { docId: 'd_1', uid: 'u_req', requestedRoleNum: 2, reason: 'need writer' }

describe('docAccessRequestRepo.submit — request_id rotation on re-submit', () => {
  it('writes request_id = VALUES(request_id) in the ON DUPLICATE KEY UPDATE', async () => {
    query
      .mockResolvedValueOnce(undefined) // the INSERT ... ON DUPLICATE KEY UPDATE
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }]) // read-back

    await docAccessRequestRepo.submit(params)

    const [insertSql, insertBinds] = query.mock.calls[0]!
    // The rotation clause — without this a stale card can cross-approve.
    expect(insertSql).toContain('request_id     = VALUES(request_id)')
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE')
    // The fresh id is bound as the INSERT candidate (last bind), so a duplicate
    // update sets request_id to this new value via VALUES(request_id).
    expect(insertBinds).toEqual(['d_1', 'u_req', 2, 'need writer', 'rotated-id-2'])
  })

  it('returns the read-back authoritative request_id (the rotated value)', async () => {
    query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ request_id: 'rotated-id-2', status: REQUEST_STATUS_PENDING }])

    const out = await docAccessRequestRepo.submit(params)
    expect(out.requestId).toBe('rotated-id-2')
    expect(out.status).toBe(REQUEST_STATUS_PENDING)
  })
})
