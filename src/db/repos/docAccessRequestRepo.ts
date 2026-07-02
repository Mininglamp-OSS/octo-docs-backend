/**
 * doc_access_request repository (§4.4, screen 4c).
 *
 * A no-permission recipient submits an access request; owner/admin pull the
 * pending list and approve/deny (MVP pull-based, no push — §4.2). PK (doc_id, uid)
 * gives natural idempotency: a repeat request from the same uid refreshes the
 * single row back to pending rather than piling up duplicate rows (mirrors
 * doc_member / doc_invite_redemption dedup范式).
 */
import { query } from '../pool.js'
import { newRequestId } from '../../util/ids.js'

export const REQUEST_STATUS_PENDING = 1
export const REQUEST_STATUS_APPROVED = 2
export const REQUEST_STATUS_DENIED = 3
export const REQUEST_STATUS_CANCELLED = 4

export interface DocAccessRequestRow {
  doc_id: string
  uid: string
  requested_role: number // 1=reader 2=writer
  reason: string
  status: number // 1=pending 2=approved 3=denied 4=cancelled
  request_id: string
  decided_by: string
  created_at: Date
  updated_at: Date
}

export const docAccessRequestRepo = {
  /**
   * Submit (or re-submit) a request. Idempotent by (doc_id, uid): a duplicate
   * refreshes the existing row to pending with the new role/reason and clears
   * the previous decision, keeping the original request_id stable so any list
   * already showing it keeps addressing the same row. Returns the row's
   * request_id and current status.
   */
  async submit(params: {
    docId: string
    uid: string
    requestedRoleNum: number
    reason: string
  }): Promise<{ requestId: string; status: number }> {
    const candidateId = newRequestId()
    await query(
      `INSERT INTO doc_access_request (doc_id, uid, requested_role, reason, status, request_id)
       VALUES (?, ?, ?, ?, ${REQUEST_STATUS_PENDING}, ?)
       ON DUPLICATE KEY UPDATE
         requested_role = VALUES(requested_role),
         reason         = VALUES(reason),
         status         = ${REQUEST_STATUS_PENDING},
         decided_by     = ''`,
      [params.docId, params.uid, params.requestedRoleNum, params.reason, candidateId],
    )
    // On a duplicate the passed candidateId is ignored (request_id is not updated),
    // so read back the authoritative row to return its real request_id + status.
    const rows = await query<{ request_id: string; status: number }>(
      'SELECT request_id, status FROM doc_access_request WHERE doc_id = ? AND uid = ? LIMIT 1',
      [params.docId, params.uid],
    )
    const row = rows[0]
    return { requestId: row?.request_id ?? candidateId, status: Number(row?.status ?? REQUEST_STATUS_PENDING) }
  },

  /** List requests for a doc filtered by status (admin pull; default pending). */
  async listByStatus(docId: string, status: number): Promise<DocAccessRequestRow[]> {
    return query<DocAccessRequestRow>(
      'SELECT * FROM doc_access_request WHERE doc_id = ? AND status = ? ORDER BY created_at ASC',
      [docId, status],
    )
  },

  /** Fetch a single request by (doc_id, request_id) for approve/deny addressing. */
  async getByRequestId(docId: string, requestId: string): Promise<DocAccessRequestRow | null> {
    const rows = await query<DocAccessRequestRow>(
      'SELECT * FROM doc_access_request WHERE doc_id = ? AND request_id = ? LIMIT 1',
      [docId, requestId],
    )
    return rows[0] ?? null
  },

  /**
   * Transition a pending request to approved/denied, recording the decider.
   * Only flips rows still pending (guards against double-processing / races).
   * Returns true when a pending row was transitioned.
   */
  async decide(params: {
    docId: string
    requestId: string
    status: number
    decidedBy: string
  }): Promise<boolean> {
    const rows = await query<{ affectedRows?: number }>(
      `UPDATE doc_access_request
         SET status = ?, decided_by = ?
       WHERE doc_id = ? AND request_id = ? AND status = ${REQUEST_STATUS_PENDING}`,
      [params.status, params.decidedBy, params.docId, params.requestId],
    )
    return (rows as unknown as { affectedRows?: number }).affectedRows! > 0
  },
}
