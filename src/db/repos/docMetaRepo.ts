/**
 * doc_meta repository (§3.4 / §8.4).
 *
 * Business metadata: title/owner/space/folder/status/permission_epoch.
 * Holds both doc_id (business PK) and document_name (Hocuspocus routing/
 * persistence key, unique). See appendix B for the naming convention.
 */
import { query, transaction, type Tx } from '../pool.js'

export interface DocMeta {
  doc_id: string
  document_name: string
  title: string
  owner_id: string
  space_id: string
  folder_id: string
  doc_type: string
  status: number // 1=active 0=deleted 2=archived
  permission_epoch: number
  created_at: Date
  updated_at: Date
  created_by: string
  updated_by: string
}

export interface CreateDocInput {
  docId: string
  documentName: string
  title: string
  ownerId: string
  spaceId: string
  folderId: string
  docType: string
  createdBy: string
}

export const docMetaRepo = {
  async create(input: CreateDocInput): Promise<void> {
    await query(
      `INSERT INTO doc_meta
         (doc_id, document_name, title, owner_id, space_id, folder_id, doc_type, status, permission_epoch, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, '')`,
      [
        input.docId,
        input.documentName,
        input.title,
        input.ownerId,
        input.spaceId,
        input.folderId,
        input.docType,
        input.createdBy,
      ],
    )
  },

  async getByDocId(docId: string): Promise<DocMeta | null> {
    const rows = await query<DocMeta>('SELECT * FROM doc_meta WHERE doc_id = ? LIMIT 1', [docId])
    return rows[0] ?? null
  },

  async getByDocumentName(documentName: string): Promise<DocMeta | null> {
    const rows = await query<DocMeta>(
      'SELECT * FROM doc_meta WHERE document_name = ? LIMIT 1',
      [documentName],
    )
    return rows[0] ?? null
  },

  /** Resolve the canonical document_name for a doc_id (§7.3 resolveDocumentName). */
  async resolveDocumentName(docId: string): Promise<string | null> {
    const rows = await query<{ document_name: string }>(
      'SELECT document_name FROM doc_meta WHERE doc_id = ? AND status <> 0 LIMIT 1',
      [docId],
    )
    return rows[0]?.document_name ?? null
  },

  async rename(docId: string, title: string): Promise<void> {
    await query('UPDATE doc_meta SET title = ? WHERE doc_id = ?', [title, docId])
  },

  /**
   * Soft delete (status=0), §8.4.
   *
   * Flips status AND bumps permission_epoch in the SAME transaction (reusing
   * bumpEpochTx, §4.5). The epoch bump is what severs live collaboration: a
   * connected writer's beforeHandleMessage sees the advanced epoch, rechecks,
   * and resolveRole returns 'none' (status===0) -> 4403 reject + readOnly.
   * Without the bump the recheck never fires and writers keep editing a deleted
   * doc. Returns the doc's document_name and the new epoch so the caller can
   * publish the invalidation event (mirrors acceptInvite); null if no such doc.
   */
  async softDelete(docId: string): Promise<{ documentName: string; permissionEpoch: number } | null> {
    return transaction(async (tx) => {
      await tx.query('UPDATE doc_meta SET status = 0 WHERE doc_id = ?', [docId])
      await docMetaRepo.bumpEpochTx(tx, docId)
      const rows = await tx.query<{ document_name: string; permission_epoch: number }>(
        'SELECT document_name, permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [docId],
      )
      const row = rows[0]
      if (!row) return null
      return { documentName: row.document_name, permissionEpoch: Number(row.permission_epoch) }
    })
  },

  /**
   * List documents the caller can see in a space/folder.
   * For this round, listing is scoped to docs the uid owns or is a member of
   * (joined with doc_member), with the resolved role surfaced per row.
   */
  async listForUser(params: {
    uid: string
    spaceId: string
    folderId?: string
    page: number
    pageSize: number
    sort: 'updatedAt:desc' | 'updatedAt:asc'
  }): Promise<{ total: number; items: Array<DocMeta & { role: number }> }> {
    const where: string[] = ['m.status <> 0']
    // Optional space/folder filters appear in the WHERE clause between the JOIN's
    // `dm.uid = ?` and the trailing `m.owner_id = ?`. Collect their bind values in
    // clause order so the full args array lines up positionally with the SQL.
    const filterArgs: unknown[] = []
    // role: owner => admin(3), else doc_member.role
    // Space isolation (P1): listing is always scoped to the caller's space; the
    // space filter is unconditional now that spaceId is required (sourced from
    // the enforced X-Space-Id header). Docs in other spaces are never returned.
    where.push('m.space_id = ?')
    filterArgs.push(params.spaceId)
    if (params.folderId) {
      where.push('m.folder_id = ?')
      filterArgs.push(params.folderId)
    }
    // Placeholders in `base`, in order: JOIN `dm.uid = ?`, then the optional
    // space/folder filters, then WHERE `m.owner_id = ?`. The join uid leads and
    // the owner uid trails — they are not interchangeable with the filters.
    const args: unknown[] = [params.uid, ...filterArgs, params.uid]
    const whereSql = where.join(' AND ')
    const order = params.sort === 'updatedAt:asc' ? 'ASC' : 'DESC'
    // `query()` runs on mysql2 `.execute()` (a prepared statement), which rejects
    // numeric LIMIT/OFFSET bound via `?` with ER_WRONG_ARGUMENTS (errno 1210) — a
    // guaranteed 500. Coerce and clamp pageSize to a positive integer in 1..100
    // and offset to a non-negative integer; both are then provably integers and
    // safe to inline directly (no injection surface).
    const pageSize = Math.min(100, Math.max(1, Number.isInteger(params.pageSize) ? params.pageSize : 20))
    const offsetRaw = (params.page - 1) * pageSize
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const base = `
      FROM doc_meta m
      LEFT JOIN doc_member dm ON dm.doc_id = m.doc_id AND dm.uid = ?
      WHERE ${whereSql} AND (m.owner_id = ? OR dm.uid IS NOT NULL)
    `
    const countRows = await query<{ cnt: number }>(`SELECT COUNT(*) AS cnt ${base}`, args)
    const total = Number(countRows[0]?.cnt ?? 0)

    const items = await query<DocMeta & { role: number }>(
      `SELECT m.*, CASE WHEN m.owner_id = ? THEN 3 ELSE dm.role END AS role
       ${base}
       ORDER BY m.updated_at ${order}
       LIMIT ${pageSize} OFFSET ${offset}`,
      [params.uid, ...args],
    )
    return { total, items }
  },

  /** Bump permission_epoch within an existing transaction (§4.5). */
  async bumpEpochTx(tx: Tx, docId: string): Promise<void> {
    await tx.query('UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?', [docId])
  },

  /** Bump permission_epoch (standalone), returns the new epoch. */
  async bumpEpoch(docId: string): Promise<number> {
    return transaction(async (tx) => {
      await tx.query('UPDATE doc_meta SET permission_epoch = permission_epoch + 1 WHERE doc_id = ?', [docId])
      const rows = await tx.query<{ permission_epoch: number }>(
        'SELECT permission_epoch FROM doc_meta WHERE doc_id = ? LIMIT 1',
        [docId],
      )
      return Number(rows[0]?.permission_epoch ?? 0)
    })
  },

  /** Read current epoch authoritatively from DB by document_name (§4.5 P2-E). */
  async getEpochByDocumentName(documentName: string): Promise<number | null> {
    const rows = await query<{ permission_epoch: number }>(
      'SELECT permission_epoch FROM doc_meta WHERE document_name = ? LIMIT 1',
      [documentName],
    )
    if (rows.length === 0) return null
    return Number(rows[0]!.permission_epoch)
  },
}
