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
import {
  type Status,
  statusFromNumber,
  statusToNumber,
  canTransition,
  InvalidTransitionError,
} from '../../comments/status.js'

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
  /** Adjudication lifecycle state; root-only (open|approved|rejected|committed). */
  status: Status
  adjudicatedBy: string | null
  adjudicatedAt: Date | null
  adjudicationNote: string
  /** Legacy DERIVED mirror for old clients: resolved = status !== 'open'. */
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
  status: number
  adjudicated_by: string | null
  adjudicated_at: Date | null
  adjudication_note: string
  resolved: number
  resolved_by: string | null
  resolved_at: Date | null
  deleted: number
  created_at: Date
  updated_at: Date
}

function mapRow(row: DocCommentRow): DocComment {
  // status is the single source of truth; resolved is derived from it so old
  // clients keep working even if a legacy row's stored `resolved` drifts.
  const status = statusFromNumber(row.status) ?? 'open'
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
    status,
    adjudicatedBy: row.adjudicated_by ?? null,
    adjudicatedAt: row.adjudicated_at ?? null,
    adjudicationNote: row.adjudication_note ?? '',
    resolved: status !== 'open',
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
  /**
   * Optional lifecycle filter. When set, roots are filtered to exactly this
   * status (overrides `includeResolved`); the agent uses status='approved' to
   * pull its execution list. When unset, `includeResolved` controls whether
   * non-open roots are included (false => open only, matching legacy behavior).
   */
  status?: Status
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
    if (opts.status !== undefined) {
      // Explicit lifecycle filter wins over includeResolved (agent execution list).
      where.push('status = ?')
      args.push(statusToNumber(opts.status))
    } else if (!opts.includeResolved) {
      // Legacy default: only open (unadjudicated) roots. status is the source of
      // truth; status=0 is exactly the old `resolved = 0` set.
      where.push('status = ?')
      args.push(statusToNumber('open'))
    }
    if (opts.cursor != null) {
      where.push('id > ?')
      args.push(opts.cursor)
    }
    // `query()` runs on mysql2 `.execute()` (a prepared statement), which rejects
    // a numeric LIMIT bound via `?` with ER_WRONG_ARGUMENTS (errno 1210) — a
    // guaranteed 500. `opts.limit` is not clamped at the call site, so coerce and
    // clamp it to a positive integer in 1..100 here; the result is provably an
    // integer and is therefore safe to inline directly (no injection surface).
    const lim = Math.min(100, Math.max(1, Number.isInteger(opts.limit) ? opts.limit : 20))
    const rows = await query<DocCommentRow>(
      `SELECT * FROM doc_comment WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ${lim}`,
      [...args],
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
   *
   * The pool's `query()` helper runs on `.execute()` (a prepared statement), and
   * mysql2 does NOT expand an array bound to a single `IN (?)` placeholder under
   * `.execute()` — that array-expansion only happens on `.query()`. So we build
   * one `?` placeholder per id and pass a FLAT param list (one value per
   * placeholder); binding the nested array against `IN (?)` would match zero
   * rows and silently drop every reply.
   */
  async listRepliesForRoots(rootIds: number[]): Promise<DocComment[]> {
    if (rootIds.length === 0) return []
    const placeholders = rootIds.map(() => '?').join(', ')
    const rows = await query<DocCommentRow>(
      `SELECT * FROM doc_comment WHERE parent_id IN (${placeholders}) AND deleted = 0 ORDER BY id ASC`,
      rootIds,
    )
    return rows.map(mapRow)
  },

  async updateBody(id: number, body: string): Promise<void> {
    await query('UPDATE doc_comment SET body = ? WHERE id = ?', [body, id])
  },

  /**
   * Adjudicate a thread root: move it to `toStatus`, enforcing the allowed
   * transition table (see comments/status.ts). Reads the current status first
   * and throws InvalidTransitionError on a disallowed move so the route can
   * 400 invalid_transition instead of silently writing.
   *
   * Stamps adjudicated_by/at (留痕 audit trail) and, for backward-compat, keeps
   * the legacy resolved mirror in sync: resolved = (toStatus !== 'open'), with
   * resolved_by/at cleared on reopen. Returns void; throws only on an invalid
   * transition or a missing root.
   */
  async setStatus(id: number, toStatus: Status, byUid: string, note = ''): Promise<void> {
    const current = await this.getById(id)
    if (!current) throw new InvalidTransitionError('open', toStatus)
    if (current.status === toStatus) {
      // No-op transition: not in the allowed table, but harmless. Treat setting a
      // root to its current status as invalid to keep the state machine strict.
      throw new InvalidTransitionError(current.status, toStatus)
    }
    if (!canTransition(current.status, toStatus)) {
      throw new InvalidTransitionError(current.status, toStatus)
    }
    const resolved = toStatus !== 'open'
    if (resolved) {
      await query(
        `UPDATE doc_comment
           SET status = ?, adjudicated_by = ?, adjudicated_at = CURRENT_TIMESTAMP(3),
               adjudication_note = ?, resolved = 1, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [statusToNumber(toStatus), byUid, note, byUid, id],
      )
    } else {
      // Reopen: clear the legacy resolved mirror, but keep the adjudication
      // stamp as the audit trail of who last acted (留痕).
      await query(
        `UPDATE doc_comment
           SET status = ?, adjudicated_by = ?, adjudicated_at = CURRENT_TIMESTAMP(3),
               adjudication_note = ?, resolved = 0, resolved_by = NULL, resolved_at = NULL
         WHERE id = ?`,
        [statusToNumber(toStatus), byUid, note, id],
      )
    }
  },

  /**
   * Legacy compatibility shim: map the old boolean resolve/reopen onto the
   * lifecycle. resolved:true -> approved, resolved:false -> open. Kept so old
   * callers/tests keep working; new code should call setStatus directly.
   */
  async setResolved(id: number, resolved: boolean, byUid: string): Promise<void> {
    await this.setStatus(id, resolved ? 'approved' : 'open', byUid)
  },

  async softDelete(id: number): Promise<void> {
    await query('UPDATE doc_comment SET deleted = 1 WHERE id = ?', [id])
  },

  /**
   * Hard delete (admin moderation). Cascades to child replies so a removed
   * thread root never leaves orphaned reply rows detached from any thread.
   * Runs both the root row and its replies in one transaction. When the target
   * is a reply (its id is never another row's parent_id under single-level
   * nesting), the `parent_id = ?` arm matches nothing and only that one row goes.
   *
   * Scoped to `doc_id` as defense-in-depth: a destructive cascade must not rely
   * solely on the caller having pre-bounded the doc. The `(id = ? OR parent_id
   * = ?) AND doc_id = ?` form removes the root + its replies within the doc and
   * can never touch another doc's rows.
   */
  async hardDelete(id: number, docId: string): Promise<void> {
    await transaction(async (tx) => {
      await tx.query(
        'DELETE FROM doc_comment WHERE (id = ? OR parent_id = ?) AND doc_id = ?',
        [id, id, docId],
      )
    })
  },
}
