/**
 * doc_view_history repository (FEAT-B recent-view).
 *
 * Per-user document view records ("recent viewed"). One row per (uid, doc_id):
 * opening a document UPSERTs the row and refreshes viewed_at, so a re-open never
 * creates a second row (idempotent dedup, PK (uid, doc_id)).
 *
 * Two responsibilities, kept strictly separate:
 *   - WRITE (upsertViewWithPrune): idempotent UPSERT + synchronous per-uid
 *     retention prune in ONE transaction (mirrors docVersionRepo.createAutoWithPrune).
 *     Pruning is capacity maintenance only.
 *   - READ (listRecent / listCreators): joins doc_meta (+ doc_member) and filters
 *     at QUERY TIME on status=1 + the visibility predicate. This — never pruning —
 *     is what makes a revoked / deleted / archived doc drop out of the next query.
 */
import { query, transaction } from '../pool.js'

/** A recent-view row joined with its doc_meta business columns. */
export interface RecentViewItem {
  doc_id: string
  title: string
  owner_id: string
  doc_type: string
  role: number // 1=reader 2=writer 3=admin (owner => 3)
  updated_at: Date
  updated_by: string // last editor uid (doc_meta.updated_by; '' when never edited)
  viewed_at: Date
}

/** Opaque keyset cursor payload: the (viewed_at, doc_id) of the last seen row. */
export interface ViewCursor {
  viewedAt: string // ISO-8601 (UTC)
  docId: string
}

/**
 * Encode a keyset cursor as base64url(JSON({v, d})). Opaque / URL-safe. The
 * front-end round-trips it verbatim; only the server reads its shape.
 */
export function encodeViewCursor(viewedAt: string, docId: string): string {
  const json = JSON.stringify({ v: viewedAt, d: docId })
  return Buffer.from(json, 'utf8').toString('base64url')
}

/**
 * Decode a keyset cursor. Returns null for a missing/empty cursor (=> first
 * page). Throws on a malformed cursor so the route can answer 400 rather than
 * silently returning the first page (which would loop the client's scroll).
 */
export function decodeViewCursor(raw: string | undefined): ViewCursor | null {
  if (raw === undefined || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid_cursor')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { v?: unknown }).v !== 'string' ||
    typeof (parsed as { d?: unknown }).d !== 'string'
  ) {
    throw new Error('invalid_cursor')
  }
  const { v, d } = parsed as { v: string; d: string }
  if (Number.isNaN(new Date(v).getTime())) throw new Error('invalid_cursor')
  return { viewedAt: v, docId: d }
}

/**
 * Escape LIKE wildcards so a user-typed `%`, `_`, or `\` matches literally. Pair
 * with `LIKE ? ESCAPE '\\'`. The utf8mb4 default collation is case-insensitive,
 * so no LOWER() is needed for CI substring matching.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export const docViewHistoryRepo = {
  /**
   * Idempotent UPSERT of one (uid, doc_id) view + synchronous per-uid retention
   * prune, in ONE transaction. Returns the row's post-write viewed_at.
   *
   * Mirrors docVersionRepo.createAutoWithPrune: doing the UPSERT and both prune
   * passes under a single transaction avoids the race where two concurrent
   * writers prune each other's rows. `retainCount` / `retainDays` are clamped to
   * non-negative integers and inlined (mysql2 `.execute()` rejects a `?` bind for
   * LIMIT / INTERVAL with ER_WRONG_ARGUMENTS; the clamped integers carry no
   * injection surface — same rationale as listForUser's LIMIT).
   *
   * Uses the `VALUES(col)` UPSERT form for broad MySQL 8 compatibility; the
   * explicit viewed_at = VALUES(viewed_at) assignment overrides the column's
   * ON UPDATE CURRENT_TIMESTAMP so the write time is deterministic (= NOW(3)).
   */
  async upsertViewWithPrune(input: {
    uid: string
    docId: string
    spaceId: string
    retainCount: number
    retainDays: number
  }): Promise<Date> {
    const keep = Math.max(0, Math.floor(input.retainCount))
    const days = Math.max(0, Math.floor(input.retainDays))
    return transaction(async (tx) => {
      await tx.query(
        `INSERT INTO doc_view_history (uid, doc_id, space_id, viewed_at)
         VALUES (?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE viewed_at = VALUES(viewed_at), space_id = VALUES(space_id)`,
        [input.uid, input.docId, input.spaceId],
      )
      // count-based prune (keep most-recent N view rows for this uid; 0 = unbounded).
      if (keep > 0) {
        await tx.query(
          `DELETE FROM doc_view_history
           WHERE uid = ?
             AND doc_id NOT IN (
               SELECT doc_id FROM (
                 SELECT doc_id FROM doc_view_history
                 WHERE uid = ?
                 ORDER BY viewed_at DESC, doc_id DESC
                 LIMIT ${keep}
               ) AS keep
             )`,
          [input.uid, input.uid],
        )
      }
      // age-based prune (drop view rows older than retainDays; 0 = unbounded).
      if (days > 0) {
        await tx.query(
          `DELETE FROM doc_view_history
           WHERE uid = ? AND viewed_at < NOW(3) - INTERVAL ${days} DAY`,
          [input.uid],
        )
      }
      const rows = await tx.query<{ viewed_at: Date }>(
        'SELECT viewed_at FROM doc_view_history WHERE uid = ? AND doc_id = ? LIMIT 1',
        [input.uid, input.docId],
      )
      return rows[0]?.viewed_at ?? new Date()
    })
  },

  /**
   * List the caller's recent-viewed docs in a space, viewed_at DESC (tie-break
   * doc_id DESC), keyset-paginated. Query-time filtering: status=1 + visibility
   * predicate (owner OR member) — a revoked / deleted / archived doc is not
   * returned on the NEXT query, regardless of any residual doc_view_history row.
   *
   * Returns pageSize items plus an opaque nextCursor (null when no further page)
   * and a total COUNT over the same WHERE (excluding the cursor bound).
   */
  async listRecent(params: {
    uid: string
    spaceId: string
    q?: string
    creators?: string[]
    types?: string[]
    cursor?: string
    pageSize: number
  }): Promise<{ items: RecentViewItem[]; nextCursor: string | null; total: number }> {
    const cursor = decodeViewCursor(params.cursor)
    const pageSize = Math.min(100, Math.max(1, Number.isInteger(params.pageSize) ? params.pageSize : 20))

    // WHERE fragments + binds, assembled in positional order. The role CASE and
    // the doc_member join both bind :uid, so the leading binds are (uid, uid, spaceId).
    const where: string[] = ['v.uid = ?', 'v.space_id = ?', 'm.status = 1', '(m.owner_id = ? OR dm.uid IS NOT NULL)']
    // filter binds follow the base binds; the base binds are added when building `args`.
    const filterArgs: unknown[] = []

    const q = (params.q ?? '').trim()
    if (q !== '') {
      where.push(`m.title LIKE ? ESCAPE '\\\\'`)
      filterArgs.push(`%${escapeLike(q)}%`)
    }
    const creators = (params.creators ?? []).filter((c) => typeof c === 'string' && c !== '')
    if (creators.length > 0) {
      where.push(`m.owner_id IN (${creators.map(() => '?').join(', ')})`)
      filterArgs.push(...creators)
    }
    // FEAT-B/XIN-1188 kind filter: multi-value OR on doc_type, applied at the same
    // layer as `q`/`creator` — narrows the keyset window BEFORE pagination, so the
    // page and the total COUNT agree. Values are pre-validated by the route; empty
    // => no predicate (backward compatible, no behavior change for old clients).
    const types = (params.types ?? []).filter((t) => typeof t === 'string' && t !== '')
    if (types.length > 0) {
      where.push(`m.doc_type IN (${types.map(() => '?').join(', ')})`)
      filterArgs.push(...types)
    }

    // base binds: role CASE `m.owner_id = ?` is only in the SELECT list (items
    // query), not the count. Build the two arg arrays separately.
    // COUNT: [v.uid, v.space_id, visibility-uid, ...filters]
    const countArgs: unknown[] = [params.uid, params.spaceId, params.uid, ...filterArgs]
    const base = `
      FROM doc_view_history v
      JOIN doc_meta m         ON m.doc_id = v.doc_id
      LEFT JOIN doc_member dm ON dm.doc_id = m.doc_id AND dm.uid = ?
      WHERE ${where.join(' AND ')}
    `
    // the doc_member join binds one uid ahead of the WHERE binds.
    const countRows = await query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt ${base}`,
      [params.uid, ...countArgs],
    )
    const total = Number(countRows[0]?.cnt ?? 0)

    // items query: role CASE binds an extra leading uid, and the keyset cursor
    // (when present) adds a trailing tuple bind.
    const cursorSql = cursor ? ' AND (v.viewed_at, v.doc_id) < (?, ?)' : ''
    const cursorArgs = cursor ? [new Date(cursor.viewedAt), cursor.docId] : []
    const items = await query<RecentViewItem>(
      `SELECT m.doc_id, m.title, m.owner_id, m.doc_type, m.updated_at, m.updated_by, v.viewed_at,
              CASE WHEN m.owner_id = ? THEN 3 ELSE dm.role END AS role
       ${base}${cursorSql}
       ORDER BY v.viewed_at DESC, v.doc_id DESC
       LIMIT ${pageSize + 1}`,
      // role CASE uid, join uid, then WHERE binds (v.uid, space, visibility uid, ...filters), then cursor.
      [params.uid, params.uid, ...countArgs, ...cursorArgs],
    )

    // Fetch pageSize+1 to detect a further page; the (pageSize+1)-th row is the
    // sentinel that signals hasMore. nextCursor is built from the LAST KEPT row.
    let nextCursor: string | null = null
    if (items.length > pageSize) {
      items.length = pageSize
      const last = items[pageSize - 1]!
      nextCursor = encodeViewCursor(new Date(last.viewed_at).toISOString(), last.doc_id)
    }
    return { items, nextCursor, total }
  },

  /**
   * Distinct creators (owner_id) of the caller's recent-viewed result set for the
   * CreatorFilter dropdown. Scope (locked): q-filtered, creator-NOT-filtered,
   * pre-pagination, query-time visibility (status=1 + owner/member) — i.e. the
   * full distinct owner set BEFORE the creator facet is applied. Name resolution
   * is done by the caller (route), which holds the octo session token.
   */
  async listCreators(params: { uid: string; spaceId: string; q?: string }): Promise<string[]> {
    const where: string[] = ['v.uid = ?', 'v.space_id = ?', 'm.status = 1', '(m.owner_id = ? OR dm.uid IS NOT NULL)']
    const args: unknown[] = [params.uid, params.spaceId, params.uid]
    const q = (params.q ?? '').trim()
    if (q !== '') {
      where.push(`m.title LIKE ? ESCAPE '\\\\'`)
      args.push(`%${escapeLike(q)}%`)
    }
    const rows = await query<{ owner_id: string }>(
      `SELECT DISTINCT m.owner_id
       FROM doc_view_history v
       JOIN doc_meta m         ON m.doc_id = v.doc_id
       LEFT JOIN doc_member dm ON dm.doc_id = m.doc_id AND dm.uid = ?
       WHERE ${where.join(' AND ')}`,
      [params.uid, ...args],
    )
    return rows.map((r) => r.owner_id)
  },
}
