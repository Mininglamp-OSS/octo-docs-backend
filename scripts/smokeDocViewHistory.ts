/**
 * FEAT-B recent-view smoke test against a REAL MySQL (throwaway container).
 * Exercises the actual repo SQL end-to-end: idempotent UPSERT, retention prune
 * (count + age), and query-time permission/status filtering. Not part of the
 * committed suite — a manual gate (`tsx scripts/smokeDocViewHistory.ts`).
 */
import { query, closePool } from '../src/db/pool.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'

const SPACE = 's_smoke'
let failures = 0
function check(label: string, cond: boolean) {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

async function seedDoc(docId: string, ownerId: string, title: string, status = 1) {
  await query(
    `INSERT INTO doc_meta (doc_id, document_name, title, owner_id, space_id, folder_id, doc_type, status, permission_epoch, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, 'f_default', 'doc', ?, 0, ?, '')
     ON DUPLICATE KEY UPDATE title=VALUES(title), status=VALUES(status)`,
    [docId, `octo:${SPACE}:f_default:${docId}`, title, ownerId, SPACE, status, ownerId],
  )
}

async function main() {
  // clean slate
  await query('DELETE FROM doc_view_history WHERE space_id = ?', [SPACE])
  await query('DELETE FROM doc_meta WHERE space_id = ?', [SPACE])

  const uid = 'u_viewer'
  // owner viewer's own docs
  for (let i = 0; i < 5; i++) await seedDoc(`d_${i}`, uid, `Spec ${i}`)
  // a doc owned by someone else, viewer is NOT a member (used for perm filter)
  await seedDoc('d_other', 'u_owner2', 'Other Report')

  // --- idempotency: open d_0 twice, only one row, viewed_at refreshed ---
  await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: 'd_0', spaceId: SPACE, retainCount: 0, retainDays: 0 })
  const first = await query<{ viewed_at: Date }>('SELECT viewed_at FROM doc_view_history WHERE uid=? AND doc_id=?', [uid, 'd_0'])
  await new Promise((r) => setTimeout(r, 20))
  await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: 'd_0', spaceId: SPACE, retainCount: 0, retainDays: 0 })
  const rowsD0 = await query<{ c: number }>('SELECT COUNT(*) c FROM doc_view_history WHERE uid=? AND doc_id=?', [uid, 'd_0'])
  const second = await query<{ viewed_at: Date }>('SELECT viewed_at FROM doc_view_history WHERE uid=? AND doc_id=?', [uid, 'd_0'])
  check('idempotent UPSERT: re-open keeps exactly ONE row', Number(rowsD0[0]!.c) === 1)
  check('idempotent UPSERT: re-open refreshes viewed_at', new Date(second[0]!.viewed_at).getTime() >= new Date(first[0]!.viewed_at).getTime())

  // --- retention criterion 1 (count): RETAIN_COUNT=3 keeps most-recent 3 ---
  await query('DELETE FROM doc_view_history WHERE uid=?', [uid])
  for (let i = 0; i < 5; i++) {
    await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: `d_${i}`, spaceId: SPACE, retainCount: 3, retainDays: 0 })
    await new Promise((r) => setTimeout(r, 10)) // stagger viewed_at
  }
  const kept = await query<{ doc_id: string }>('SELECT doc_id FROM doc_view_history WHERE uid=? ORDER BY viewed_at DESC', [uid])
  check('retention count=3: only 3 rows remain', kept.length === 3)
  check('retention count=3: the most-recent 3 (d_4,d_3,d_2) survive', kept.map((k) => k.doc_id).join(',') === 'd_4,d_3,d_2')

  // --- retention criterion 2 (age): RETAIN_DAYS=1 drops a 2-day-old row ---
  await query('DELETE FROM doc_view_history WHERE uid=?', [uid])
  await query('INSERT INTO doc_view_history (uid,doc_id,space_id,viewed_at) VALUES (?,?,?, NOW(3) - INTERVAL 2 DAY)', [uid, 'd_1', SPACE])
  await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: 'd_0', spaceId: SPACE, retainCount: 0, retainDays: 1 })
  const afterAge = await query<{ doc_id: string }>('SELECT doc_id FROM doc_view_history WHERE uid=?', [uid])
  check('retention days=1: 2-day-old row pruned, today survives', afterAge.length === 1 && afterAge[0]!.doc_id === 'd_0')

  // --- retention criterion 3 (prune != permission filter) + query-time filter ---
  await query('DELETE FROM doc_view_history WHERE uid=?', [uid])
  // view d_0 (own) and d_other (no membership). No pruning (unbounded).
  await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: 'd_0', spaceId: SPACE, retainCount: 0, retainDays: 0 })
  await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: 'd_other', spaceId: SPACE, retainCount: 0, retainDays: 0 })
  const both = await query<{ c: number }>('SELECT COUNT(*) c FROM doc_view_history WHERE uid=?', [uid])
  const recent1 = await docViewHistoryRepo.listRecent({ uid, spaceId: SPACE, pageSize: 20 })
  check('query-time filter: both rows physically present (not pruned)', Number(both[0]!.c) === 2)
  check('query-time filter: d_other (no permission) is NOT returned', !recent1.items.some((r) => r.doc_id === 'd_other'))
  check('query-time filter: d_0 (owned) IS returned', recent1.items.some((r) => r.doc_id === 'd_0'))

  // soft-delete d_0 -> next query drops it immediately, though its row lingers
  await query('UPDATE doc_meta SET status=0 WHERE doc_id=?', ['d_0'])
  const recent2 = await docViewHistoryRepo.listRecent({ uid, spaceId: SPACE, pageSize: 20 })
  const lingering = await query<{ c: number }>('SELECT COUNT(*) c FROM doc_view_history WHERE uid=? AND doc_id=?', [uid, 'd_0'])
  check('query-time filter: soft-deleted d_0 vanishes from recent next query', !recent2.items.some((r) => r.doc_id === 'd_0'))
  check('query-time filter: correctness does NOT depend on pruning (row still present)', Number(lingering[0]!.c) === 1)

  // --- keyset pagination: no dup / no gap across pages ---
  await query('UPDATE doc_meta SET status=1 WHERE doc_id=?', ['d_0'])
  await query('DELETE FROM doc_view_history WHERE uid=?', [uid])
  for (let i = 0; i < 5; i++) {
    await docViewHistoryRepo.upsertViewWithPrune({ uid, docId: `d_${i}`, spaceId: SPACE, retainCount: 0, retainDays: 0 })
    await new Promise((r) => setTimeout(r, 10))
  }
  const seen: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const res = await docViewHistoryRepo.listRecent({ uid, spaceId: SPACE, cursor, pageSize: 2 })
    seen.push(...res.items.map((r) => r.doc_id))
    if (!res.nextCursor) break
    cursor = res.nextCursor
  }
  check('keyset paging: all 5 docs seen, no duplicates', seen.length === 5 && new Set(seen).size === 5)
  check('keyset paging: viewed_at DESC order (d_4..d_0)', seen.join(',') === 'd_4,d_3,d_2,d_1,d_0')

  // --- search normalization + creators facet ---
  const searched = await docViewHistoryRepo.listRecent({ uid, spaceId: SPACE, q: 'SPEC 1', pageSize: 20 })
  check('search: CI substring "SPEC 1" matches "Spec 1"', searched.items.length === 1 && searched.items[0]!.doc_id === 'd_1')
  const creators = await docViewHistoryRepo.listCreators({ uid, spaceId: SPACE })
  check('creators facet: distinct owner of viewed+visible docs = [u_viewer]', creators.length === 1 && creators[0] === uid)

  // cleanup
  await query('DELETE FROM doc_view_history WHERE space_id=?', [SPACE])
  await query('DELETE FROM doc_meta WHERE space_id=?', [SPACE])
  await closePool()
  // eslint-disable-next-line no-console
  console.log(`\n${failures === 0 ? 'ALL SMOKE CHECKS PASSED' : failures + ' SMOKE CHECK(S) FAILED'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
