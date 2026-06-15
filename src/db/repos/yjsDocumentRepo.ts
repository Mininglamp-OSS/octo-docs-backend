/**
 * yjs_document repository (§3.2 / §3.4).
 *
 * Y.Doc binary authoritative state, single merged row per document_name
 * (uk_document_name). store() uses UPSERT + merge-on-write; see persistence.ts
 * for the full read-modify-write transaction (the merge logic lives there
 * because it needs Y.Doc decode/encode).
 */
import { query, type Tx } from '../pool.js'

export const yjsDocumentRepo = {
  /** Fetch raw state bytes for a document_name (§3.2 fetch). */
  async fetchState(documentName: string): Promise<Uint8Array | null> {
    // db.query returns []; must index [0] before reading state, else
    // new Uint8Array(undefined) reads garbage (§3.2 P2-1).
    const rows = await query<{ state: Buffer }>(
      'SELECT state FROM yjs_document WHERE document_name = ? LIMIT 1',
      [documentName],
    )
    const row = rows[0]
    return row ? new Uint8Array(row.state) : null
  },

  /** SELECT ... FOR UPDATE inside the store transaction (§3.2 step 1). */
  async selectForUpdateTx(tx: Tx, documentName: string): Promise<Uint8Array | null> {
    const rows = await tx.query<{ state: Buffer }>(
      'SELECT state FROM yjs_document WHERE document_name = ? FOR UPDATE',
      [documentName],
    )
    const row = rows[0]
    return row ? new Uint8Array(row.state) : null
  },

  /** UPSERT the single authoritative row (§3.2 step 3). */
  async upsertStateTx(tx: Tx, documentName: string, state: Buffer): Promise<void> {
    await tx.query(
      `INSERT INTO yjs_document (document_name, state, size_bytes, updated_at)
       VALUES (?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE state = VALUES(state),
                               size_bytes = VALUES(size_bytes),
                               updated_at = NOW(3)`,
      [documentName, state, state.length],
    )
  },
}
