import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for docViewHistoryRepo: the REAL repo methods run against a
// mocked pool (query + transaction), so we assert the exact (sql, params) shape
// — idempotent UPSERT, synchronous per-uid retention prune (both passes), the
// query-time permission/status filter, keyset-cursor paging, and the cursor
// codec — with no live MySQL (mirrors docVersionPrune.test.ts).
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import {
  docViewHistoryRepo,
  encodeViewCursor,
  decodeViewCursor,
} from '../src/db/repos/docViewHistoryRepo.js'
import { query, transaction } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

interface Call {
  sql: string
  params: unknown[]
}

/** Wire `transaction` to a tx that records every query; the final SELECT
 *  viewed_at resolves to a fixed timestamp. */
function mockTx(viewedAt = new Date('2026-07-15T06:20:48.123Z')): Call[] {
  const calls: Call[] = []
  vi.mocked(transaction).mockImplementation(async (fn: never) => {
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params })
        if (sql.includes('SELECT viewed_at')) return [{ viewed_at: viewedAt }]
        return []
      }),
    }
    return (fn as unknown as (t: typeof tx) => Promise<unknown>)(tx)
  })
  return calls
}

beforeEach(() => {
  vi.mocked(transaction).mockReset()
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('docViewHistoryRepo.upsertViewWithPrune — idempotent UPSERT + prune', () => {
  it('UPSERTs on (uid, doc_id): a re-open refreshes viewed_at, never inserts a new row', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 200, retainDays: 90,
    })
    const insert = calls.find((c) => c.sql.includes('INSERT INTO doc_view_history'))
    expect(insert).toBeDefined()
    // idempotency is the ON DUPLICATE KEY UPDATE arm refreshing viewed_at (+space).
    expect(insert!.sql).toContain('ON DUPLICATE KEY UPDATE')
    expect(insert!.sql).toMatch(/viewed_at\s*=\s*VALUES\(viewed_at\)/)
    expect(insert!.params).toEqual(['u_1', 'd_1', 's1'])
  })

  it('returns the post-write viewed_at read back inside the same transaction', async () => {
    mockTx(new Date('2026-07-15T06:20:48.123Z'))
    const out = await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 200, retainDays: 90,
    })
    expect(out.toISOString()).toBe('2026-07-15T06:20:48.123Z')
  })

  it('count prune (retainCount=3) keeps the most-recent 3 via an inlined LIMIT, keyed by uid', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 3, retainDays: 0,
    })
    const del = calls.find((c) => c.sql.includes('DELETE') && c.sql.includes('NOT IN'))
    expect(del).toBeDefined()
    expect(del!.sql).toMatch(/LIMIT 3\b/)
    expect(del!.sql).not.toMatch(/LIMIT \?/)
    expect(del!.sql).toMatch(/ORDER BY viewed_at DESC, doc_id DESC/)
    // both the DELETE scope and the keep-set subquery are pinned to this uid.
    expect(del!.params).toEqual(['u_1', 'u_1'])
    // 3 must not leak into params (inlined, not bound).
    expect(del!.params).not.toContain(3)
  })

  it('age prune (retainDays=1) drops rows older than an inlined INTERVAL, keyed by uid', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 0, retainDays: 1,
    })
    const del = calls.find((c) => c.sql.includes('DELETE') && c.sql.includes('INTERVAL'))
    expect(del).toBeDefined()
    expect(del!.sql).toMatch(/INTERVAL 1 DAY/)
    expect(del!.sql).not.toMatch(/INTERVAL \? DAY/)
    expect(del!.params).toEqual(['u_1'])
  })

  it('skips the count pass when retainCount=0 and the age pass when retainDays=0 (0 = unbounded)', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 0, retainDays: 0,
    })
    expect(calls.some((c) => c.sql.includes('DELETE'))).toBe(false)
  })

  it('clamps a fractional / negative retainCount to a safe non-negative integer', async () => {
    const calls = mockTx()
    await docViewHistoryRepo.upsertViewWithPrune({
      uid: 'u_1', docId: 'd_1', spaceId: 's1', retainCount: 3.9, retainDays: -5,
    })
    const del = calls.find((c) => c.sql.includes('NOT IN'))
    expect(del!.sql).toMatch(/LIMIT 3\b/) // floor(3.9)=3
    // retainDays=-5 clamps to 0 => no age pass.
    expect(calls.some((c) => c.sql.includes('INTERVAL'))).toBe(false)
  })
})

describe('docViewHistoryRepo.listRecent — query-time filter + keyset paging', () => {
  it('filters at query time on status=1 + the owner-or-member visibility predicate', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never) // count
    mockQuery.mockResolvedValueOnce([] as never) // items
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 20 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    // this — NOT pruning — is what makes revoked/deleted/archived docs vanish.
    expect(itemsSql).toContain('m.status = 1')
    expect(itemsSql).toContain('(m.owner_id = ? OR dm.uid IS NOT NULL)')
    expect(itemsSql).toMatch(/ORDER BY v\.viewed_at DESC, v\.doc_id DESC/)
  })

  it('fetches pageSize+1 (inlined LIMIT) and derives nextCursor from the last kept row', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      doc_id: `d_${i}`, title: `T${i}`, owner_id: 'u_o', doc_type: 'doc', role: 1,
      updated_at: new Date('2026-07-10T00:00:00.000Z'),
      viewed_at: new Date(`2026-07-15T06:00:0${i}.000Z`),
    }))
    mockQuery.mockResolvedValueOnce([{ cnt: 9 }] as never) // count
    mockQuery.mockResolvedValueOnce(rows as never) // items: pageSize(2)+1 = 3 rows
    const out = await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 2 })
    const itemsSql = mockQuery.mock.calls.at(-1)![0] as string
    expect(itemsSql).toMatch(/LIMIT 3\b/) // pageSize(2)+1
    expect(itemsSql).not.toMatch(/LIMIT \?/)
    expect(out.items).toHaveLength(2) // truncated back to pageSize
    expect(out.total).toBe(9)
    // nextCursor decodes to the 2nd (last kept) row's (viewed_at, doc_id).
    const cur = decodeViewCursor(out.nextCursor!)!
    expect(cur.docId).toBe('d_1')
    expect(cur.viewedAt).toBe('2026-07-15T06:00:01.000Z')
  })

  it('returns nextCursor=null when the page is not full (no further page)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 1 }] as never)
    mockQuery.mockResolvedValueOnce([
      { doc_id: 'd_0', title: 'T', owner_id: 'u_o', doc_type: 'doc', role: 3,
        updated_at: new Date(0), viewed_at: new Date('2026-07-15T06:00:00.000Z') },
    ] as never)
    const out = await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', pageSize: 20 })
    expect(out.nextCursor).toBeNull()
    expect(out.items).toHaveLength(1)
  })

  it('applies a keyset cursor as a (viewed_at, doc_id) tuple comparison with bound params', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 5 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    const cursor = encodeViewCursor('2026-07-15T06:00:01.000Z', 'd_1')
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', cursor, pageSize: 20 })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain('(v.viewed_at, v.doc_id) < (?, ?)')
    // the cursor viewed_at binds as a Date (mysql2 round-trips DATETIME as Date).
    const curDate = params.find((p) => p instanceof Date && (p as Date).toISOString() === '2026-07-15T06:00:01.000Z')
    expect(curDate).toBeDefined()
    expect(params).toContain('d_1')
  })

  it('escapes LIKE wildcards in q so a literal %/_ matches literally (CI substring)', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', q: '  50%_off  ', pageSize: 20 })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'")
    // trimmed + wildcards escaped.
    expect(params).toContain('%50\\%\\_off%')
  })

  it('creator multi-select becomes owner_id IN (?, ?) — OR between creators, AND with q', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({
      uid: 'u_1', spaceId: 's1', q: 'spec', creators: ['u_a', 'u_b'], pageSize: 20,
    })
    const call = mockQuery.mock.calls.at(-1)!
    const sql = call[0] as string
    const params = call[1] as unknown[]
    expect(sql).toContain('m.owner_id IN (?, ?)')
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'") // AND-ed with q
    expect(params).toContain('u_a')
    expect(params).toContain('u_b')
  })

  it('an empty creators array short-circuits to no IN clause (no empty IN ())', async () => {
    mockQuery.mockResolvedValueOnce([{ cnt: 0 }] as never)
    mockQuery.mockResolvedValueOnce([] as never)
    await docViewHistoryRepo.listRecent({ uid: 'u_1', spaceId: 's1', creators: [], pageSize: 20 })
    const sql = mockQuery.mock.calls.at(-1)![0] as string
    expect(sql).not.toContain('IN ()')
    expect(sql).not.toContain('owner_id IN')
  })
})

describe('docViewHistoryRepo.listCreators — pre-facet distinct owners', () => {
  it('returns DISTINCT owners under q + query-time permission filter, WITHOUT the creator filter', async () => {
    mockQuery.mockResolvedValueOnce([{ owner_id: 'u_a' }, { owner_id: 'u_b' }] as never)
    const out = await docViewHistoryRepo.listCreators({ uid: 'u_1', spaceId: 's1', q: 'spec' })
    const sql = mockQuery.mock.calls.at(-1)![0] as string
    expect(sql).toContain('SELECT DISTINCT m.owner_id')
    expect(sql).toContain('m.status = 1')
    expect(sql).toContain('(m.owner_id = ? OR dm.uid IS NOT NULL)')
    expect(sql).toContain("LIKE ? ESCAPE '\\\\'") // respects q
    expect(sql).not.toContain('owner_id IN') // NOT the creator filter
    expect(out).toEqual(['u_a', 'u_b'])
  })
})

describe('keyset cursor codec', () => {
  it('round-trips (viewed_at, doc_id) through base64url', () => {
    const enc = encodeViewCursor('2026-07-15T06:00:01.000Z', 'd_9')
    expect(decodeViewCursor(enc)).toEqual({ viewedAt: '2026-07-15T06:00:01.000Z', docId: 'd_9' })
  })

  it('treats a missing/empty cursor as the first page (null)', () => {
    expect(decodeViewCursor(undefined)).toBeNull()
    expect(decodeViewCursor('')).toBeNull()
  })

  it('throws invalid_cursor on garbage / wrong shape / unparseable date', () => {
    expect(() => decodeViewCursor('!!!not-base64-json')).toThrow('invalid_cursor')
    expect(() => decodeViewCursor(Buffer.from('{"v":"x"}').toString('base64url'))).toThrow('invalid_cursor')
    expect(() =>
      decodeViewCursor(Buffer.from('{"v":"not-a-date","d":"d_1"}').toString('base64url')),
    ).toThrow('invalid_cursor')
  })
})
