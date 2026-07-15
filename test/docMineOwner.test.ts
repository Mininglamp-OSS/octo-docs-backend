import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the FEAT-B "my documents" extension of listForUser:
// owner='me' tightens visibility to strictly owner_id==uid (excludes
// shared-with-me), and q adds a CI substring title match with escaped wildcards.
// The REAL repo runs against a mocked pool; we assert the (sql, params) shape.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

/** The (sql, params) of the items query (the last call; count is the prior one). */
function itemsCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.at(-1)!
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] }
}

describe('docMetaRepo.listForUser — owner=me / q (FEAT-B)', () => {
  it('default (no owner) keeps the owner-OR-member visibility predicate', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    expect(itemsCall().sql).toContain('(m.owner_id = ? OR dm.uid IS NOT NULL)')
  })

  it("owner='me' tightens to strictly owner_id==uid, dropping the shared-with-me branch", async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', owner: 'me', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    const { sql } = itemsCall()
    expect(sql).not.toContain('OR dm.uid IS NOT NULL')
    // still keyed on the owner predicate.
    expect(sql).toMatch(/AND m\.owner_id = \?/)
  })

  it('q adds an escaped CI substring title match (trimmed, wildcards literal)', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', q: '  a_b%  ', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    const { sql, params } = itemsCall()
    expect(sql).toContain("m.title LIKE ? ESCAPE '\\\\'")
    expect(params).toContain('%a\\_b\\%%')
  })

  it('empty / whitespace-only q adds no LIKE clause (= no search)', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', q: '   ', page: 1, pageSize: 20, sort: 'updatedAt:desc' })
    expect(itemsCall().sql).not.toContain('LIKE')
  })

  it('orders by updated_at with a doc_id tie-break and an inlined LIMIT/OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', spaceId: 's1', page: 2, pageSize: 20, sort: 'updatedAt:desc' })
    const { sql, params } = itemsCall()
    expect(sql).toMatch(/ORDER BY m\.updated_at DESC, m\.doc_id DESC/)
    expect(sql).toMatch(/LIMIT 20 OFFSET 20/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(20)
  })
})
