/**
 * Idempotency receipt store for signed card-action callbacks
 * (docs/card-action-callback-consumer.md §Onboarding step 5, §transaction).
 *
 * A callback is at-least-once: the same `event_id` may be delivered again after
 * a timeout / crash / lost response. We CLAIM the event_id first (INSERT IGNORE);
 * the winner executes the domain decision and FINALIZEs the stored response, and
 * any redelivery replays that exact stored response instead of re-transitioning.
 * A claim whose response is still NULL (a prior attempt crashed before finalize)
 * is safe to re-execute because the domain ops are idempotent (decide() is a
 * pending→terminal CAS; grantForwardAccess is only-up).
 */
import { query } from '../pool.js'

export const docCardActionReceiptRepo = {
  /** Claim an event_id. Returns true iff THIS call inserted the row (owns it). */
  async claim(eventId: string): Promise<boolean> {
    const rows = await query('INSERT IGNORE INTO card_action_receipt (event_id) VALUES (?)', [eventId])
    return (rows as unknown as { affectedRows?: number }).affectedRows === 1
  },

  /** Read the stored JSON response, or null when unclaimed / claimed-but-unfinalized. */
  async getResponse(eventId: string): Promise<string | null> {
    const rows = await query<{ response: string | null }>(
      'SELECT response FROM card_action_receipt WHERE event_id = ? LIMIT 1',
      [eventId],
    )
    return rows.length ? (rows[0]!.response ?? null) : null
  },

  /**
   * Persist the final JSON response for a claimed event_id. CAS-guarded with
   * `response IS NULL` so a concurrent redelivery (Caller B re-executing after a
   * crashed-but-claimed row) cannot overwrite the first finalized response —
   * octo-server's retry logic replays the original disposition, not B's.
   * Returns true iff THIS call won the CAS (wrote the response); a false result
   * means another execution finalized first, so the caller must read and return
   * that stored winner response instead of its own (replay-exact contract).
   */
  async finalize(eventId: string, response: string): Promise<boolean> {
    const rows = await query(
      'UPDATE card_action_receipt SET response = ? WHERE event_id = ? AND response IS NULL',
      [response, eventId],
    )
    return (rows as unknown as { affectedRows?: number }).affectedRows === 1
  },
}
