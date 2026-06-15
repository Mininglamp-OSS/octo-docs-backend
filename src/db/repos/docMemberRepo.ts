/**
 * doc_member repository (§3.4 / §4.2 / §8.4).
 *
 * Document-autonomous membership. resolveRole queries this table + owner only
 * (§4.2); no group inheritance. PK (doc_id, uid) => at most one row per pair.
 */
import { query, type Tx } from '../pool.js'
import { roleFromNumber, type Role } from '../../permission/role.js'

export interface DocMemberRow {
  doc_id: string
  uid: string
  role: number
  granted_by: string
  source: number // 1=direct 2=invite
  invite_token: string
  created_at: Date
  updated_at: Date
}

export const SOURCE_DIRECT = 1
export const SOURCE_INVITE = 2

export const docMemberRepo = {
  /** Read a single member row's role (§4.2 resolveRole). Returns undefined if no row. */
  async getRole(docId: string, uid: string): Promise<Role | undefined> {
    const rows = await query<{ role: number }>(
      'SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? LIMIT 1',
      [docId, uid],
    )
    if (rows.length === 0) return undefined
    return roleFromNumber(Number(rows[0]!.role))
  },

  async list(docId: string): Promise<DocMemberRow[]> {
    return query<DocMemberRow>(
      'SELECT * FROM doc_member WHERE doc_id = ? ORDER BY created_at ASC',
      [docId],
    )
  },

  /** Direct add / update role (§8.4 PUT members). Upsert by (doc_id, uid). */
  async upsertDirect(params: {
    docId: string
    uid: string
    roleNum: number
    grantedBy: string
  }): Promise<void> {
    await query(
      `INSERT INTO doc_member (doc_id, uid, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ${SOURCE_DIRECT}, '')
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
      [params.docId, params.uid, params.roleNum, params.grantedBy],
    )
  },

  async remove(docId: string, uid: string): Promise<void> {
    await query('DELETE FROM doc_member WHERE doc_id = ? AND uid = ?', [docId, uid])
  },

  // ── transaction-scoped variants for the invite accept flow (§4.6) ──────────

  async getRoleTx(tx: Tx, docId: string, uid: string): Promise<Role | undefined> {
    const rows = await tx.query<{ role: number }>(
      'SELECT role FROM doc_member WHERE doc_id = ? AND uid = ? LIMIT 1',
      [docId, uid],
    )
    if (rows.length === 0) return undefined
    return roleFromNumber(Number(rows[0]!.role))
  },

  /** Insert/rebuild a member row from an accepted invite (§4.6 branch c/d). */
  async upsertFromInviteTx(
    tx: Tx,
    params: { docId: string; uid: string; roleNum: number; grantedBy: string; inviteToken: string },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO doc_member (doc_id, uid, role, granted_by, source, invite_token)
       VALUES (?, ?, ?, ?, ${SOURCE_INVITE}, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by),
                               source = VALUES(source), invite_token = VALUES(invite_token)`,
      [params.docId, params.uid, params.roleNum, params.grantedBy, params.inviteToken],
    )
  },
}
