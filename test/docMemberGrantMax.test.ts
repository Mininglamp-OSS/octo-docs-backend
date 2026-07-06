import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for docMemberRepo.upsertGrantMax (§2 max-merge). The method
// runs a single INSERT ... ON DUPLICATE KEY UPDATE with GREATEST(role, VALUES(role))
// and reports whether a genuine grant/upgrade happened via the ResultSetHeader's
// affectedRows (insert=1, real update=2, no-change=0). We mock the pool so the
// SQL is asserted and the affectedRows -> boolean contract is locked without a DB.
const execute = vi.fn()
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ execute }),
  // query is imported by the repo module but unused on this path; stub it.
  query: vi.fn(async () => []),
}))

import { docMemberRepo, SOURCE_DIRECT } from '../src/db/repos/docMemberRepo.js'

beforeEach(() => {
  execute.mockReset()
})

const params = { docId: 'd_1', uid: 'u_recipient', roleNum: 1, grantedBy: 'u_admin' }

describe('docMemberRepo.upsertGrantMax — only-up max-merge', () => {
  it('uses GREATEST + source=direct and passes the bind values in order', async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }, undefined])
    await docMemberRepo.upsertGrantMax(params)

    const [sql, binds] = execute.mock.calls[0]!
    expect(sql).toContain('GREATEST(role, VALUES(role))')
    expect(sql).toContain('IF(VALUES(role) > role, VALUES(granted_by), granted_by)')
    // source=direct is inlined (SOURCE_DIRECT), invite_token=''.
    expect(sql).toContain(`${SOURCE_DIRECT}, ''`)
    expect(binds).toEqual(['d_1', 'u_recipient', 1, 'u_admin'])
  })

  it('affectedRows=1 (fresh insert) -> changed true', async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }, undefined])
    expect(await docMemberRepo.upsertGrantMax(params)).toBe(true)
  })

  it('affectedRows=2 (real upgrade) -> changed true', async () => {
    execute.mockResolvedValue([{ affectedRows: 2 }, undefined])
    expect(await docMemberRepo.upsertGrantMax(params)).toBe(true)
  })

  it('affectedRows=0 (already >= target, GREATEST no-op) -> changed false', async () => {
    execute.mockResolvedValue([{ affectedRows: 0 }, undefined])
    expect(await docMemberRepo.upsertGrantMax(params)).toBe(false)
  })
})
