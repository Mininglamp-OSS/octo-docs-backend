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

  /** Soft delete (status=0), §8.4. */
  async softDelete(docId: string): Promise<void> {
    await query('UPDATE doc_meta SET status = 0 WHERE doc_id = ?', [docId])
  },

  /**
   * List documents the caller can see in a space/folder.
   * For this round, listing is scoped to docs the uid owns or is a member of
   * (joined with doc_member), with the resolved role surfaced per row.
   */
  async listForUser(params: {
    uid: string
    spaceId?: string
    folderId?: string
    page: number
    pageSize: number
    sort: 'updatedAt:desc' | 'updatedAt:asc'
  }): Promise<{ total: number; items: Array<DocMeta & { role: number }> }> {
    const where: string[] = ['m.status <> 0']
    const args: unknown[] = [params.uid, params.uid]
    // role: owner => admin(3), else doc_member.role
    if (params.spaceId) {
      where.push('m.space_id = ?')
      args.push(params.spaceId)
    }
    if (params.folderId) {
      where.push('m.folder_id = ?')
      args.push(params.folderId)
    }
    const whereSql = where.join(' AND ')
    const order = params.sort === 'updatedAt:asc' ? 'ASC' : 'DESC'
    const offset = (params.page - 1) * params.pageSize

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
       LIMIT ? OFFSET ?`,
      [params.uid, ...args, params.pageSize, offset],
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
