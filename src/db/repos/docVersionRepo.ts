/**
 * doc_version repository (§4 feature #4 — version history snapshot + restore).
 *
 * Each row is the full Yjs authoritative state of the document at snapshot time
 * (Y.encodeStateAsUpdate), gzip-compressed into state_blob. The id is assigned
 * by the DB (AUTO_INCREMENT) — it IS the version_seq, never MAX+1 in app code.
 *
 * Columns map snake_case -> camelCase in the typed return (see DocVersion). The
 * binary state is stored compressed (node:zlib gzipSync) and decompressed on
 * read (gunzipSync); size_bytes records the UNCOMPRESSED length for metrics /
 * retention. Listing never fetches state_blob (large) — only getStateById does.
 */
import { gzipSync, gunzipSync } from 'node:zlib'
import { query, transaction, type Tx } from '../pool.js'

/** kind discriminator (doc_version.kind TINYINT). */
export const KIND_AUTO = 1
export const KIND_NAMED = 2
export const KIND_RESTORE_MARKER = 3

export interface DocVersion {
  id: number
  docId: string
  documentName: string
  kind: number
  name: string
  /** For a restore-marker row: the source version_seq it was restored from; null otherwise. */
  restoredFrom: number | null
  compressed: number
  sizeBytes: number
  schemaVersion: number
  createdAt: Date
  createdBy: string
}

/** Row shape for the metadata projection (no state_blob). */
interface DocVersionMetaRow {
  id: number
  doc_id: string
  document_name: string
  kind: number
  name: string
  restored_from: number | null
  compressed: number
  size_bytes: number
  schema_version: number
  created_at: Date
  created_by: string
}

/** Full row including the binary blob (only selected by getStateById). */
interface DocVersionRow extends DocVersionMetaRow {
  state_blob: Buffer
}

function mapRow(row: DocVersionMetaRow): DocVersion {
  return {
    id: Number(row.id),
    docId: row.doc_id,
    documentName: row.document_name,
    kind: Number(row.kind),
    name: row.name,
    restoredFrom: row.restored_from == null ? null : Number(row.restored_from),
    compressed: Number(row.compressed),
    sizeBytes: Number(row.size_bytes),
    schemaVersion: Number(row.schema_version),
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

// Metadata projection used by every read path except getStateById, so the
// LONGBLOB is never pulled into memory for listings / ownership checks.
const META_COLS =
  'id, doc_id, document_name, kind, name, restored_from, compressed, size_bytes, schema_version, created_at, created_by'

export interface CreateVersionInput {
  docId: string
  documentName: string
  kind: number
  name?: string
  /** Source version_seq for a restore-marker row; omitted (null) for normal snapshots. */
  restoredFrom?: number
  /** Raw (uncompressed) Yjs state = Y.encodeStateAsUpdate(doc) at snapshot time. */
  state: Uint8Array
  schemaVersion: number
  createdBy: string
}

/** Filter dimension for listByDoc (maps to a kind SQL predicate). */
export type VersionKindFilter = 'manual' | 'auto' | 'all'

export interface ListVersionsOptions {
  cursor?: number
  limit?: number
  /**
   * Kind filter: `manual` = kind <> AUTO (named + restore), `auto` = kind = AUTO,
   * `all` = no kind predicate. Takes precedence over `includeAuto` when set.
   */
  kind?: VersionKindFilter
  /**
   * Backward-compat alias, honoured ONLY when `kind` is absent:
   * true -> 'all', false/absent -> 'manual' (preserves the legacy default of
   * excluding auto snapshots).
   */
  includeAuto?: boolean
}

/** Per-kind full counts for a doc (independent of limit/cursor). */
export interface VersionCounts {
  auto: number
  manual: number
  restore: number
  total: number
}

/** Input for an auto snapshot written with same-transaction retention pruning. */
export interface CreateAutoInput {
  docId: string
  documentName: string
  /** Raw (uncompressed) Yjs state = Y.encodeStateAsUpdate(doc) at snapshot time. */
  state: Uint8Array
  schemaVersion: number
  createdBy: string
  /** Keep at most the most-recent N auto rows for this doc (AUTO_RETAIN_COUNT). */
  retainCount: number
  /** Drop auto rows older than this many days (AUTO_RETAIN_DAYS). */
  retainDays: number
}

export const docVersionRepo = {
  /**
   * Insert a snapshot row within an existing transaction; returns the DB-assigned
   * id (LAST_INSERT_ID). Used by the restore flow so the safety snapshot is
   * created atomically with the restore write.
   */
  async createTx(tx: Tx, input: CreateVersionInput): Promise<number> {
    const blob = gzipSync(Buffer.from(input.state))
    await tx.query(
      `INSERT INTO doc_version
         (doc_id, document_name, kind, name, restored_from, state_blob, compressed, size_bytes, schema_version, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        input.docId,
        input.documentName,
        input.kind,
        input.name ?? '',
        input.restoredFrom ?? null,
        blob,
        input.state.length,
        input.schemaVersion,
        input.createdBy,
      ],
    )
    const rows = await tx.query<{ id: number }>('SELECT LAST_INSERT_ID() AS id')
    return Number(rows[0]!.id)
  },

  /** Insert a snapshot row (standalone transaction); returns the new id. */
  async create(input: CreateVersionInput): Promise<number> {
    return transaction((tx) => this.createTx(tx, input))
  },

  /**
   * Insert a KIND_AUTO snapshot and prune stale auto rows in ONE transaction
   * (§5.4 / §0-A A4-2). Doing both under a single transaction avoids the race
   * where two concurrent afterStoreDocument writers prune each other's rows.
   *
   * Two prune passes, both pinned to `kind = KIND_AUTO` as a HARD constraint:
   * KIND_NAMED / KIND_RESTORE_MARKER rows are NEVER eligible for deletion.
   *   1. by count — keep the most-recent `retainCount` auto rows (ORDER BY id
   *      DESC for a stable "latest N"). MySQL forbids referencing the target
   *      table directly in a DELETE subquery, so the keep-set is wrapped in an
   *      aliased derived table.
   *   2. by age  — drop auto rows older than `retainDays` days.
   * Both run on the existing idx_doc_kind (doc_id, kind, id) index.
   *
   * `retainCount` / `retainDays` are clamped to non-negative integers and
   * inlined into the SQL: mysql2 `.execute()` (prepared statements) rejects a
   * `?` bind for LIMIT / INTERVAL with ER_WRONG_ARGUMENTS, and the clamped
   * integers carry no injection surface (same rationale as listByDoc's LIMIT).
   */
  async createAutoWithPrune(input: CreateAutoInput): Promise<number> {
    const keep = Math.max(1, Math.floor(input.retainCount))
    const days = Math.max(0, Math.floor(input.retainDays))
    return transaction(async (tx) => {
      const id = await this.createTx(tx, {
        docId: input.docId,
        documentName: input.documentName,
        kind: KIND_AUTO,
        state: input.state,
        schemaVersion: input.schemaVersion,
        createdBy: input.createdBy,
      })
      // 1. count-based prune (keep most-recent N auto rows for this doc).
      await tx.query(
        `DELETE FROM doc_version
         WHERE doc_id = ? AND kind = ?
           AND id NOT IN (
             SELECT id FROM (
               SELECT id FROM doc_version
               WHERE doc_id = ? AND kind = ?
               ORDER BY id DESC
               LIMIT ${keep}
             ) AS keep
           )`,
        [input.docId, KIND_AUTO, input.docId, KIND_AUTO],
      )
      // 2. age-based prune (drop auto rows older than retainDays).
      await tx.query(
        `DELETE FROM doc_version
         WHERE doc_id = ? AND kind = ?
           AND created_at < NOW() - INTERVAL ${days} DAY`,
        [input.docId, KIND_AUTO],
      )
      return id
    })
  },

  /** Metadata for one version (no blob). Returns null if absent. */
  async getById(id: number): Promise<DocVersion | null> {
    const rows = await query<DocVersionMetaRow>(
      `SELECT ${META_COLS} FROM doc_version WHERE id = ? LIMIT 1`,
      [id],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  /**
   * Version metadata + the raw (decompressed) Yjs state bytes. Used by the
   * /state preview endpoint and by restore. Returns null if absent.
   */
  async getStateById(id: number): Promise<{ version: DocVersion; state: Uint8Array } | null> {
    const rows = await query<DocVersionRow>('SELECT * FROM doc_version WHERE id = ? LIMIT 1', [id])
    const row = rows[0]
    if (!row) return null
    const raw = Number(row.compressed) === 1 ? gunzipSync(row.state_blob) : row.state_blob
    return { version: mapRow(row), state: new Uint8Array(raw) }
  },

  /**
   * List a doc's versions newest-first with id-cursor pagination. The kind
   * filter selects which streams are returned: `manual` (named + restore),
   * `auto`, or `all`. `kind` takes precedence; when absent the legacy
   * `includeAuto` alias maps true -> 'all', false/absent -> 'manual' (the
   * historical default of excluding auto snapshots). Each kind stream paginates
   * independently — the cursor is just id < cursor on the filtered set.
   */
  async listByDoc(
    docId: string,
    opts: ListVersionsOptions = {},
  ): Promise<{ items: DocVersion[]; nextCursor: number | null }> {
    const limit = Math.min(100, Math.max(1, Number.isInteger(opts.limit) ? opts.limit! : 20))
    const filter: VersionKindFilter = opts.kind ?? (opts.includeAuto ? 'all' : 'manual')
    const conds = ['doc_id = ?']
    const args: unknown[] = [docId]
    if (filter === 'manual') {
      conds.push('kind <> ?')
      args.push(KIND_AUTO)
    } else if (filter === 'auto') {
      conds.push('kind = ?')
      args.push(KIND_AUTO)
    }
    if (opts.cursor != null) {
      conds.push('id < ?')
      args.push(opts.cursor)
    }
    // Fetch one extra row to decide whether a further page exists.
    // `query()` runs on mysql2 `.execute()` (a prepared statement), which rejects
    // a numeric LIMIT/OFFSET bound via `?` with ER_WRONG_ARGUMENTS (errno 1210) —
    // a guaranteed 500. `limit` is clamped to an integer in 1..100 above, so
    // `limit + 1` is provably a positive integer and is safe to inline directly.
    const lim = limit + 1
    const rows = await query<DocVersionMetaRow>(
      `SELECT ${META_COLS} FROM doc_version
       WHERE ${conds.join(' AND ')}
       ORDER BY id DESC
       LIMIT ${lim}`,
      [...args],
    )
    const hasMore = rows.length > limit
    const items = (hasMore ? rows.slice(0, limit) : rows).map(mapRow)
    const nextCursor = hasMore ? items[items.length - 1]!.id : null
    return { items, nextCursor }
  },

  /**
   * Per-kind full counts for a doc, independent of limit/cursor. A single
   * COUNT(*) ... GROUP BY kind over idx_doc_kind (doc_id, kind, id) maps to the
   * four reported fields: auto (kind=1), manual (kind=2, NAMED only), restore
   * (kind=3), and their total. Missing kinds report 0.
   */
  async countsByKind(docId: string): Promise<VersionCounts> {
    const rows = await query<{ kind: number; c: number }>(
      `SELECT kind, COUNT(*) AS c FROM doc_version WHERE doc_id = ? GROUP BY kind`,
      [docId],
    )
    const counts: VersionCounts = { auto: 0, manual: 0, restore: 0, total: 0 }
    for (const row of rows) {
      const n = Number(row.c)
      if (Number(row.kind) === KIND_AUTO) counts.auto = n
      else if (Number(row.kind) === KIND_NAMED) counts.manual = n
      else if (Number(row.kind) === KIND_RESTORE_MARKER) counts.restore = n
    }
    counts.total = counts.auto + counts.manual + counts.restore
    return counts
  },

  /** Rename a named snapshot's label. */
  async rename(id: number, name: string): Promise<void> {
    await query('UPDATE doc_version SET name = ? WHERE id = ?', [name, id])
  },

  async deleteById(id: number): Promise<void> {
    await query('DELETE FROM doc_version WHERE id = ?', [id])
  },
}
