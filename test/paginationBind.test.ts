import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression for the prepared-statement pagination 500: `query()` runs on
// mysql2 `.execute()`, which rejects a numeric LIMIT/OFFSET bound via `?` with
// ER_WRONG_ARGUMENTS (errno 1210). The fix inlines a validated integer instead.
// These tests capture the (sql, params) handed to the pool and assert the shape
// the bug would have violated: LIMIT/OFFSET are inlined integers, never `?`, and
// their values are absent from the params array. This is the shape assertion
// that would have caught the original bug without a live MySQL connection.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

/** The (sql, params) of the last `query()` call. */
function lastCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.at(-1)
  if (!call) throw new Error('query() was never called')
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('paginated repos inline a validated integer LIMIT/OFFSET (no numeric `?` bind)', () => {
  it('docVersionRepo.listByDoc inlines LIMIT and drops it from params', async () => {
    await docVersionRepo.listByDoc('d_1', { limit: 20 })
    const { sql, params } = lastCall()
    // Fetches limit+1 to detect a further page; clamp(20)+1 = 21.
    expect(sql).toMatch(/LIMIT 21\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    // Only the bind params survive (doc_id, plus kind filter by default); the
    // limit value (21) must not appear among them.
    expect(params).not.toContain(21)
    expect(params).not.toContain(20)
  })

  it('docCommentRepo.listRoots inlines LIMIT and clamps an untrusted value', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 50 } as never)
    const { sql, params } = lastCall()
    expect(sql).toMatch(/LIMIT 50\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(50)
  })

  it('docCommentRepo.listRoots clamps an out-of-range / non-integer limit to 1..100', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 9999 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 100\b/)

    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 0 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 1\b/)

    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 12.5 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 20\b/)
  })

  it('docMetaRepo.listForUser inlines both LIMIT and OFFSET and drops them from params', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 3, pageSize: 25, sort: 'updatedAt:desc' })
    const { sql, params } = lastCall()
    expect(sql).toMatch(/LIMIT 25 OFFSET 50\b/) // offset = (page-1)*pageSize = 50
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(sql).not.toMatch(/OFFSET \?/)
    expect(params).not.toContain(25)
    expect(params).not.toContain(50)
  })

  it('docMetaRepo.listForUser clamps pageSize and never emits a negative OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 1, pageSize: 9999, sort: 'updatedAt:asc' })
    expect(lastCall().sql).toMatch(/LIMIT 100 OFFSET 0\b/)
  })

  // The production 500 fired on requests that carried no limit at all, not just
  // on out-of-range values. These assert the omitted-limit path still inlines a
  // safe integer LIMIT (the default) rather than falling back to a `?` bind.
  it('docVersionRepo.listByDoc with no opts inlines the default LIMIT', async () => {
    await docVersionRepo.listByDoc('d_1')
    const { sql, params } = lastCall()
    // default limit 20 → fetch limit+1 = 21.
    expect(sql).toMatch(/LIMIT 21\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(21)
    expect(params).not.toContain(20)
  })

  it('docCommentRepo.listRoots with no limit field inlines the default LIMIT', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true } as never)
    const { sql } = lastCall()
    expect(sql).toMatch(/LIMIT 20\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
  })

  it('docMetaRepo.listForUser with pageSize omitted inlines the default LIMIT/OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 3, sort: 'updatedAt:desc' } as never)
    const { sql, params } = lastCall()
    // default pageSize 20 → offset = (3-1)*20 = 40.
    expect(sql).toMatch(/LIMIT 20 OFFSET 40\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(sql).not.toMatch(/OFFSET \?/)
    expect(params).not.toContain(20)
    expect(params).not.toContain(40)
  })
})
