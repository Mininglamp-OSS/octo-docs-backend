/**
 * doc_invite repository (§3.4 / §4.6 / §8.4).
 *
 * Link invites: one token carries a granted role. Only registered octo users
 * can accept (§4.6 HARD CONSTRAINT — identity verified at accept time).
 */
import { query, type Tx } from '../pool.js'

export const INVITE_STATUS_ACTIVE = 1
export const INVITE_STATUS_REVOKED = 0
export const INVITE_STATUS_EXHAUSTED = 2
export const INVITE_STATUS_EXPIRED = 3

export interface DocInviteRow {
  invite_token: string
  doc_id: string
  role: number
  max_uses: number
  used_count: number
  expires_at: Date | null
  status: number
  created_by: string
  created_at: Date
  updated_at: Date
}

export const docInviteRepo = {
  async create(params: {
    inviteToken: string
    docId: string
    roleNum: number
    maxUses: number
    expiresAt: Date | null
    createdBy: string
  }): Promise<void> {
    await query(
      `INSERT INTO doc_invite (invite_token, doc_id, role, max_uses, used_count, expires_at, status, created_by)
       VALUES (?, ?, ?, ?, 0, ?, ${INVITE_STATUS_ACTIVE}, ?)`,
      [params.inviteToken, params.docId, params.roleNum, params.maxUses, params.expiresAt, params.createdBy],
    )
  },

  async listActive(docId: string): Promise<DocInviteRow[]> {
    return query<DocInviteRow>(
      `SELECT * FROM doc_invite WHERE doc_id = ? AND status = ${INVITE_STATUS_ACTIVE} ORDER BY created_at DESC`,
      [docId],
    )
  },

  async get(inviteToken: string): Promise<DocInviteRow | null> {
    const rows = await query<DocInviteRow>(
      'SELECT * FROM doc_invite WHERE invite_token = ? LIMIT 1',
      [inviteToken],
    )
    return rows[0] ?? null
  },

  /** Revoke an invite (§8.4 DELETE). */
  async revoke(inviteToken: string): Promise<void> {
    await query('UPDATE doc_invite SET status = ? WHERE invite_token = ?', [INVITE_STATUS_REVOKED, inviteToken])
  },

  // ── accept-flow transaction helpers (§4.6) ─────────────────────────────────

  /** SELECT ... FOR UPDATE the invite row inside the accept transaction. */
  async getForUpdateTx(tx: Tx, inviteToken: string): Promise<DocInviteRow | null> {
    const rows = await tx.query<DocInviteRow>(
      'SELECT * FROM doc_invite WHERE invite_token = ? FOR UPDATE',
      [inviteToken],
    )
    return rows[0] ?? null
  },

  async setStatusTx(tx: Tx, inviteToken: string, status: number): Promise<void> {
    await tx.query('UPDATE doc_invite SET status = ? WHERE invite_token = ?', [status, inviteToken])
  },

  /**
   * Increment used_count and, only when max_uses > 0 and used_count >= max_uses,
   * mark the invite exhausted (§4.6 branch d; max_uses=0 = unlimited).
   */
  async incrementUsedCountTx(tx: Tx, inviteToken: string): Promise<void> {
    await tx.query(
      `UPDATE doc_invite
         SET used_count = used_count + 1,
             status = CASE
               WHEN max_uses > 0 AND used_count + 1 >= max_uses THEN ${INVITE_STATUS_EXHAUSTED}
               ELSE status
             END
       WHERE invite_token = ?`,
      [inviteToken],
    )
  },
}
