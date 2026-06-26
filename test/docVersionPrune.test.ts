import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for createAutoWithPrune: the REAL repo method runs against a
// mocked pool transaction, so we can assert the INSERT + both prune passes run
// in one transaction and that every prune is pinned to kind = KIND_AUTO (named /
// restore-marker rows are never touched).
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docVersionRepo, KIND_AUTO } from '../src/db/repos/docVersionRepo.js'
import { transaction } from '../src/db/pool.js'

interface Call {
  sql: string
  params: unknown[]
}

/** Wire `transaction` to a tx that records every query and fakes LAST_INSERT_ID. */
function mockTx(insertId = 4242): Call[] {
  const calls: Call[] = []
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params })
        if (sql.includes('LAST_INSERT_ID')) return [{ id: insertId }]
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
  return calls
}

const baseInput = {
  docId: 'd_1',
  documentName: 'octo:s1:f1:d_1',
  state: new Uint8Array([1, 2, 3]),
  schemaVersion: 15,
  createdBy: 'u_w',
  retainCount: 50,
  retainDays: 7,
}

beforeEach(() => {
  vi.mocked(transaction).mockReset()
})

describe('docVersionRepo.createAutoWithPrune', () => {
  it('inserts the KIND_AUTO row and returns the DB-assigned id', async () => {
    const calls = mockTx(99)
    const id = await docVersionRepo.createAutoWithPrune(baseInput)
    expect(id).toBe(99)

    const insert = calls.find((c) => c.sql.includes('INSERT INTO doc_version'))
    expect(insert).toBeDefined()
    // kind is the 3rd bind in createTx's INSERT (doc_id, document_name, kind, ...).
    expect(insert!.params[2]).toBe(KIND_AUTO)
  })

  it('runs both prune passes pinned to kind = KIND_AUTO (never named/restore)', async () => {
    const calls = mockTx()
    await docVersionRepo.createAutoWithPrune(baseInput)

    const deletes = calls.filter((c) => c.sql.includes('DELETE FROM doc_version'))
    expect(deletes).toHaveLength(2)
    for (const d of deletes) {
      // every prune statement constrains kind, and binds KIND_AUTO for it.
      expect(d.sql).toContain('kind = ?')
      expect(d.params).toContain(KIND_AUTO)
      // hard constraint: a prune must never name the other kinds.
      expect(d.sql).not.toMatch(/kind\s*<>/)
    }
  })

  it('count prune keeps the most-recent N via a derived table ordered by id DESC', async () => {
    const calls = mockTx()
    await docVersionRepo.createAutoWithPrune({ ...baseInput, retainCount: 50 })

    const countPrune = calls.find((c) => c.sql.includes('NOT IN'))
    expect(countPrune).toBeDefined()
    expect(countPrune!.sql).toContain('ORDER BY id DESC')
    // derived table alias (MySQL forbids a direct same-table DELETE subquery).
    expect(countPrune!.sql).toContain('AS keep')
    // retainCount is inlined (mysql2 execute() rejects a ? bind for LIMIT).
    expect(countPrune!.sql).toContain('LIMIT 50')
  })

  it('age prune drops auto rows older than retainDays', async () => {
    const calls = mockTx()
    await docVersionRepo.createAutoWithPrune({ ...baseInput, retainDays: 7 })

    const agePrune = calls.find((c) => c.sql.includes('INTERVAL'))
    expect(agePrune).toBeDefined()
    expect(agePrune!.sql).toContain('INTERVAL 7 DAY')
  })

  it('clamps a non-positive retainCount to keep at least 1', async () => {
    const calls = mockTx()
    await docVersionRepo.createAutoWithPrune({ ...baseInput, retainCount: 0 })
    const countPrune = calls.find((c) => c.sql.includes('NOT IN'))
    expect(countPrune!.sql).toContain('LIMIT 1')
  })

  it('performs insert then both prunes in a single transaction', async () => {
    const calls = mockTx()
    await docVersionRepo.createAutoWithPrune(baseInput)
    // one transaction, and the INSERT precedes both DELETEs.
    expect(transaction).toHaveBeenCalledTimes(1)
    const insertIdx = calls.findIndex((c) => c.sql.includes('INSERT INTO doc_version'))
    const deleteIdxs = calls
      .map((c, i) => (c.sql.includes('DELETE FROM doc_version') ? i : -1))
      .filter((i) => i >= 0)
    expect(insertIdx).toBeGreaterThanOrEqual(0)
    expect(deleteIdxs.every((i) => i > insertIdx)).toBe(true)
  })
})
