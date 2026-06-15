/**
 * doc_invite_redemption repository (§3.4 / §4.6).
 *
 * Redemption ledger: PK (invite_token, uid) is the idempotency anchor that
 * prevents the same uid from consuming used_count more than once (§4.6).
 */
import { type Tx } from '../pool.js'

export const docInviteRedemptionRepo = {
  /** EXISTS check inside the accept transaction (§4.6 step 3 `redeemed`). */
  async existsTx(tx: Tx, inviteToken: string, uid: string): Promise<boolean> {
    const rows = await tx.query<{ one: number }>(
      'SELECT 1 AS one FROM doc_invite_redemption WHERE invite_token = ? AND uid = ? LIMIT 1',
      [inviteToken, uid],
    )
    return rows.length > 0
  },

  /** Record a first-time redemption (§4.6 branch d). */
  async insertTx(tx: Tx, inviteToken: string, uid: string): Promise<void> {
    await tx.query(
      'INSERT INTO doc_invite_redemption (invite_token, uid) VALUES (?, ?)',
      [inviteToken, uid],
    )
  },
}
