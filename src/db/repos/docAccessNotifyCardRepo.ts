/**
 * doc_access_notify_card repository (task docs-access-decision-card-sync).
 *
 * Ledger of the notification cards delivered to a document's approvers (owner +
 * admins — "某审批人") when an access request is submitted. One row per
 * (request_id, recipient) records the card's IM coordinates so the approve/deny
 * path can locate EVERY approver's card and drive it to a terminal state, not
 * just the one the decider clicked.
 *
 * Best-effort: this ledger is an enhancement, never the source of truth. The
 * decision state machine (doc_access_request.decide, WHERE status=pending) and
 * the pull-based pending list remain authoritative if a row is missing or a
 * mutate fails.
 */
import { query } from '../pool.js'

export const NOTIFY_CARD_STATUS_ACTIVE = 1
export const NOTIFY_CARD_STATUS_TERMINALIZED = 2

export interface DocAccessNotifyCardRow {
  request_id: string
  recipient_uid: string
  channel_id: string
  channel_type: number
  message_id: string
  client_msg_no: string
  status: number
  created_at: Date
  updated_at: Date
}

/** One delivered card's coordinates, as returned by octo-server's notify. */
export interface NotifyCardCoord {
  recipientUid: string
  channelId: string
  channelType: number
  messageId: string
  clientMsgNo: string
}

export const docAccessNotifyCardRepo = {
  /**
   * Persist the delivered-card coordinates for one access request. Idempotent by
   * (request_id, recipient_uid): a resend refreshes the row to the latest card
   * and resets it to ACTIVE. No-op on an empty list.
   */
  async record(requestId: string, cards: NotifyCardCoord[]): Promise<void> {
    if (cards.length === 0) return
    const values = cards.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params: unknown[] = []
    for (const c of cards) {
      params.push(
        requestId,
        c.recipientUid,
        c.channelId,
        c.channelType,
        c.messageId,
        c.clientMsgNo,
        NOTIFY_CARD_STATUS_ACTIVE,
      )
    }
    await query(
      `INSERT INTO doc_access_notify_card
         (request_id, recipient_uid, channel_id, channel_type, message_id, client_msg_no, status)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
         channel_id    = VALUES(channel_id),
         channel_type  = VALUES(channel_type),
         message_id    = VALUES(message_id),
         client_msg_no = VALUES(client_msg_no),
         status        = VALUES(status)`,
      params,
    )
  },

  /** All delivered cards for a request (decision-time fan-out lookup). */
  async listByRequest(requestId: string): Promise<DocAccessNotifyCardRow[]> {
    return query<DocAccessNotifyCardRow>(
      'SELECT * FROM doc_access_notify_card WHERE request_id = ?',
      [requestId],
    )
  },

  /** Mark one card terminalized after a successful mutate (best-effort audit). */
  async markTerminalized(requestId: string, recipientUid: string): Promise<void> {
    await query(
      `UPDATE doc_access_notify_card SET status = ${NOTIFY_CARD_STATUS_TERMINALIZED}
       WHERE request_id = ? AND recipient_uid = ?`,
      [requestId, recipientUid],
    )
  },
}
