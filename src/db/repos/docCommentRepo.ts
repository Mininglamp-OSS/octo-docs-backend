/**
 * doc_comment repository (feature #3 — inline comments).
 *
 * Stores inline-comment threads out-of-band from the Y.Doc: a thread root
 * (parent_id IS NULL) carries the opaque Yjs RelativePosition anchor bytes; its
 * replies (parent_id -> root id, single-level nesting) carry no anchors. The
 * server never parses the anchor bytes — they are read/written as opaque BLOBs.
 *
 * The id is allocated by the DB (AUTO_INCREMENT), never app-side. Columns map
 * snake_case -> camelCase in the typed return (see DocComment).
 */
import { query, transaction } from '../pool.js'

export interface DocComment {
  id: number
  docId: string
  documentName: string
  parentId: number | null
  authorUid: string
  body: string
  anchorStart: Buffer | null
  anchorEnd: Buffer | null
  anchorText: string
  resolved: boolean
  resolvedBy: string | null
  resolvedAt: Date | null
  deleted: boolean
  createdAt: Date
  updatedAt: Date
}

interface DocCommentRow {
  id: number | string
  doc_id: string
  document_name: string
  parent_id: number | string | null
  author_uid: string
  body: string
  anchor_start: Buffer | null
  anchor_end: Buffer | null
  anchor_text: string
  resolved: number
  resolved_by: string | null
  resolved_at: Date | null
  deleted: number
  created_at: Date
  updated_at: Date
}

function mapRow(row: DocCommentRow): DocComment {
  return {
    id: Number(row.id),
    docId: row.doc_id,
    documentName: row.document_name,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    authorUid: row.author_uid,
    body: row.body,
    anchorStart: row.anchor_start ?? null,
    anchorEnd: row.anchor_end ?? null,
    anchorText: row.anchor_text,
    resolved: row.resolved === 1,
    resolvedBy: row.resolved_by ?? null,
    resolvedAt: row.resolved_at ?? null,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface CreateCommentInput {
  docId: string
  documentName: string
  parentId: number | null
  authorUid: string
  body: string
  /** Opaque RelativePosition bytes; root only (NULL for replies). */
  anchorStart: Buffer | null
  anchorEnd: Buffer | null
  anchorText: string
}

export interface ListRootsOptions {
  includeResolved: boolean
  /** Return roots with id strictly greater than this cursor (ascending paging). */
  cursor: number | null
  limit: number
}

export const docCommentRepo = {
  /**
   * Insert a root or reply and return the DB-assigned id. Runs in a transaction
   * so LAST_INSERT_ID() is read on the same connection that did the INSERT.
   */
  async create(input: CreateCommentInput): Promise<number> {
    return transaction(async (tx) => {
      await tx.query(
        `INSERT INTO doc_comment
           (doc_id, document_name, parent_id, author_uid, body, anchor_start, anchor_end, anchor_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.docId,
          input.documentName,
          input.parentId,
          input.authorUid,
          input.body,
          input.anchorStart,
          input.anchorEnd,
          input.anchorText,
        ],
      )
      const rows = await tx.query<{ id: number | string }>('SELECT LAST_INSERT_ID() AS id')
      return Number(rows[0]?.id ?? 0)
    })
  },

  async getById(id: number): Promise<DocComment | null> {
    const rows = await query<DocCommentRow>('SELECT * FROM doc_comment WHERE id = ? LIMIT 1', [id])
    return rows[0] ? mapRow(rows[0]) : null
  },

  /** All non-deleted comments for a doc (roots + replies), oldest first. */
  async listByDoc(docId: string): Promise<DocComment[]> {
    const rows = await query<DocCommentRow>(
      'SELECT * FROM doc_comment WHERE doc_id = ? AND deleted = 0 ORDER BY id ASC',
      [docId],
    )
    return rows.map(mapRow)
  },

  /** Thread roots for a doc, ascending by id, cursor-paginated. */
  async listRoots(docId: string, opts: ListRootsOptions): Promise<DocComment[]> {
    const where = ['doc_id = ?', 'parent_id IS NULL', 'deleted = 0']
    const args: unknown[] = [docId]
    if (!opts.includeResolved) {
      where.push('resolved = 0')
    }
    if (opts.cursor != null) {
      where.push('id > ?')
      args.push(opts.cursor)
    }
    const rows = await query<DocCommentRow>(
      `SELECT * FROM doc_comment WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
      [...args, opts.limit],
    )
    return rows.map(mapRow)
  },

  /** Non-deleted replies of a thread root, oldest first. */
  async listReplies(parentId: number): Promise<DocComment[]> {
    const rows = await query<DocCommentRow>(
      'SELECT * FROM doc_comment WHERE parent_id = ? AND deleted = 0 ORDER BY id ASC',
      [parentId],
    )
    return rows.map(mapRow)
  },

  /**
   * Non-deleted replies for many thread roots in a single query, oldest first.
   * Lets the list path avoid an N+1 (one listReplies per root); callers group
   * the flat result by parentId. Returns [] without querying when given no ids.
   * mysql2 expands the `IN (?)` placeholder from the array argument.
   */
  async listRepliesForRoots(rootIds: number[]): Promise<DocComment[]> {
    if (rootIds.length === 0) return []
    const rows = await query<DocCommentRow>(
      'SELECT * FROM doc_comment WHERE parent_id IN (?) AND deleted = 0 ORDER BY id ASC',
      [rootIds],
    )
    return rows.map(mapRow)
  },

  async updateBody(id: number, body: string): Promise<void> {
    await query('UPDATE doc_comment SET body = ? WHERE id = ?', [body, id])
  },

  /** Resolve / reopen a thread root; stamps resolved_by/resolved_at when set. */
  async setResolved(id: number, resolved: boolean, byUid: string): Promise<void> {
    if (resolved) {
      await query(
        'UPDATE doc_comment SET resolved = 1, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
        [byUid, id],
      )
    } else {
      await query(
        'UPDATE doc_comment SET resolved = 0, resolved_by = NULL, resolved_at = NULL WHERE id = ?',
        [id],
      )
    }
  },

  async softDelete(id: number): Promise<void> {
    await query('UPDATE doc_comment SET deleted = 1 WHERE id = ?', [id])
  },

  async hardDelete(id: number): Promise<void> {
    await query('DELETE FROM doc_comment WHERE id = ?', [id])
  },
}
