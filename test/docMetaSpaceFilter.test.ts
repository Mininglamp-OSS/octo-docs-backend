import { describe, it, expect, vi, beforeEach } from 'vitest'

// Strict by-space isolation (P1) at the repo layer: docMetaRepo.listForUser must
// ALWAYS constrain the query by space (`m.space_id = ?` bound to the caller's
// space). Previously the space clause was conditional; this test locks in the
// unconditional filter so a listing can never leak docs from another space.
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

describe('docMetaRepo.listForUser always filters by space (P1 isolation)', () => {
  it('emits an unconditional m.space_id = ? clause bound to the requested space', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_scope',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // Both the COUNT and the items SELECT carry the space clause.
    for (const call of mockQuery.mock.calls) {
      const sql = call[0] as string
      const params = (call[1] ?? []) as unknown[]
      expect(sql).toMatch(/m\.space_id = \?/)
      expect(params).toContain('s_scope')
    }
  })

  it('keeps folder optional — no folder clause when folderId is omitted', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_scope',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const countSql = mockQuery.mock.calls[0]![0] as string
    expect(countSql).not.toMatch(/m\.folder_id = \?/)
  })

  it('binds space then folder positionally when a folder is also given', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_scope',
      folderId: 'f_1',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // COUNT placeholder order: JOIN dm.uid, m.space_id, m.folder_id, WHERE m.owner_id.
    const countParams = (mockQuery.mock.calls[0]![1] ?? []) as unknown[]
    expect(countParams).toEqual(['u_1', 's_scope', 'f_1', 'u_1'])
  })
})
