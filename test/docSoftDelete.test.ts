import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: the real repos run against a mocked MySQL pool. softDelete
// goes through `transaction`; the recheck path reads doc_meta via `query`.
// This anchors the §8.4 invariant that a soft delete severs live collaboration:
//   1. softDelete flips status=0 AND bumps permission_epoch in the SAME tx, and
//   2. the recheck path (beforeHandleMessage -> recheckCurrentRole) returns
//      'none' for the former owner/admin once status===0.
const txQueries: Array<{ sql: string; params: unknown[] }> = []
const queryCalls: Array<{ sql: string; params: unknown[] }> = []

// Deleted doc_meta row as returned post-softDelete (status===0).
const deletedRow = {
  doc_id: 'd_1',
  document_name: 'octo:s:f:d_1',
  title: 'Doc',
  owner_id: 'u_owner',
  space_id: 's',
  folder_id: 'f',
  doc_type: 'doc',
  status: 0,
  permission_epoch: 8,
  created_at: new Date(0),
  updated_at: new Date(0),
  created_by: 'u_owner',
  updated_by: 'u_owner',
}

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    queryCalls.push({ sql, params })
    // recheckCurrentRole -> docMetaRepo.getByDocumentName
    if (/FROM doc_meta WHERE document_name/i.test(sql)) return [deletedRow]
    return []
  }),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      async query(sql: string, params: unknown[] = []) {
        txQueries.push({ sql, params })
        // The read-back SELECT after the status flip + epoch bump.
        if (/^\s*SELECT/i.test(sql)) {
          return [{ document_name: deletedRow.document_name, permission_epoch: 8 }]
        }
        return []
      },
    }
    return fn(tx)
  }),
}))

import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { recheckCurrentRole } from '../src/permission/resolveRole.js'

beforeEach(() => {
  txQueries.length = 0
  queryCalls.length = 0
})

describe('docMetaRepo.softDelete severs live collaboration (§8.4)', () => {
  it('flips status=0 AND bumps permission_epoch in the same transaction', async () => {
    const out = await docMetaRepo.softDelete('d_1')

    const sql = txQueries.map((q) => q.sql).join('\n')
    // status flip and epoch bump must BOTH happen in the one transaction.
    expect(sql).toMatch(/status\s*=\s*0/i)
    // Fails if someone later removes the epoch bump from softDelete.
    expect(sql).toMatch(/permission_epoch\s*=\s*permission_epoch\s*\+\s*1/i)

    // Returns the doc's name + new epoch so the route can publish the event.
    expect(out).toEqual({ documentName: 'octo:s:f:d_1', permissionEpoch: 8 })
  })

  it('recheck returns none for the former owner/admin once status===0', async () => {
    // This is the actual beforeHandleMessage recheck path. Fails if recheck
    // ever stops reading doc_meta.status — the doc would stay writable.
    const role = await recheckCurrentRole('octo:s:f:d_1', 'u_owner')
    expect(role).toBe('none')
  })
})
