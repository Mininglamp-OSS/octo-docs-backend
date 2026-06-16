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
  'id, doc_id, document_name, kind, name, compressed, size_bytes, schema_version, created_at, created_by'

export interface CreateVersionInput {
  docId: string
  documentName: string
  kind: number
  name?: string
  /** Raw (uncompressed) Yjs state = Y.encodeStateAsUpdate(doc) at snapshot time. */
  state: Uint8Array
  schemaVersion: number
  createdBy: string
}

export interface ListVersionsOptions {
  cursor?: number
  limit?: number
  includeAuto?: boolean
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
         (doc_id, document_name, kind, name, state_blob, compressed, size_bytes, schema_version, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        input.docId,
        input.documentName,
        input.kind,
        input.name ?? '',
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
   * List a doc's versions newest-first with id-cursor pagination. `includeAuto`
   * controls whether kind=auto snapshots are surfaced (default: excluded). The
   * cursor is the smallest id already returned; the next page is id < cursor.
   */
  async listByDoc(
    docId: string,
    opts: ListVersionsOptions = {},
  ): Promise<{ items: DocVersion[]; nextCursor: number | null }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20))
    const conds = ['doc_id = ?']
    const args: unknown[] = [docId]
    if (!opts.includeAuto) {
      conds.push('kind <> ?')
      args.push(KIND_AUTO)
    }
    if (opts.cursor != null) {
      conds.push('id < ?')
      args.push(opts.cursor)
    }
    // Fetch one extra row to decide whether a further page exists.
    const rows = await query<DocVersionMetaRow>(
      `SELECT ${META_COLS} FROM doc_version
       WHERE ${conds.join(' AND ')}
       ORDER BY id DESC
       LIMIT ?`,
      [...args, limit + 1],
    )
    const hasMore = rows.length > limit
    const items = (hasMore ? rows.slice(0, limit) : rows).map(mapRow)
    const nextCursor = hasMore ? items[items.length - 1]!.id : null
    return { items, nextCursor }
  },

  /** Rename a named snapshot's label. */
  async rename(id: number, name: string): Promise<void> {
    await query('UPDATE doc_version SET name = ? WHERE id = ?', [name, id])
  },

  async deleteById(id: number): Promise<void> {
    await query('DELETE FROM doc_version WHERE id = ?', [id])
  },
}
