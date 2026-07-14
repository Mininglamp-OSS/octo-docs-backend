import { describe, it, expect, vi, beforeEach } from 'vitest'

// Persistence-layer oracle for the #64 migration/default (design §2 / §6 AC1/AC6):
// - docMetaRepo.create MUST NOT set the share columns, so a new doc relies on the
//   DDL defaults (share_scope=0 restricted / share_role=1 read) — no accidental
//   exposure.
// - docMetaRepo.setShareSettings issues the exact UPDATE the share API depends on.
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

describe('docMetaRepo — share columns default restricted (#64)', () => {
  it('create() never writes share_scope/share_role (new docs default to restricted)', async () => {
    await docMetaRepo.create({
      docId: 'd_new',
      documentName: 'octo:s1:f_default:d_new',
      title: 't',
      ownerId: 'u_1',
      spaceId: 's1',
      folderId: 'f_default',
      docType: 'doc',
      createdBy: 'u_1',
    })
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toMatch(/INSERT INTO doc_meta/)
    expect(sql).not.toMatch(/share_scope/)
    expect(sql).not.toMatch(/share_role/)
  })

  it('setShareSettings emits UPDATE ... SET share_scope=?, share_role=? WHERE doc_id=?', async () => {
    await docMetaRepo.setShareSettings('d_1', 1, 2)
    const [sql, params] = mockQuery.mock.calls[0]! as unknown as [string, unknown[]]
    expect(sql).toMatch(/UPDATE doc_meta SET share_scope = \?, share_role = \? WHERE doc_id = \?/)
    expect(params).toEqual([1, 2, 'd_1'])
  })
})
