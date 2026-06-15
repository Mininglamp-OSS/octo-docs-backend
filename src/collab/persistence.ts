/**
 * Persistence adapter for @hocuspocus/extension-database (§3.2 / §3.3).
 *
 * Authoritative store is the Y.Doc binary (§3.1). Single-row authoritative
 * merged-state model (§3.3): UPSERT into yjs_document, merge-on-write with a
 * diffUpdate fast-path bypass (P1-D), inside SELECT ... FOR UPDATE.
 *
 * store() also writes doc_meta.updated_by from context.user.id (P2-A) in the
 * same transaction.
 */
import * as Y from 'yjs'
import { transaction } from '../db/pool.js'
import { yjsDocumentRepo } from '../db/repos/yjsDocumentRepo.js'
import { config } from '../config/env.js'

/**
 * An empty Yjs v1 update encodes as two zero bytes (no structs, empty delete
 * set). Y has no exported isEmptyUpdate, so we check the known encoding.
 */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 2 && update[0] === 0 && update[1] === 0
}

export interface StoreContext {
  user?: { id?: string }
}

/**
 * Pure merge-on-write computation (§3.2). Returns the bytes to persist and
 * whether the union fallback path ran (for diagnostics/tests).
 *
 * Direction is critical (P1-D): surplus = diffUpdate(existing, sv(incoming)).
 * Empty surplus => existing ⊆ incoming (incoming is the superset) => write
 * incoming directly. The reverse would misjudge a stale incoming and drop
 * existing's edits.
 */
export function computeFinalState(
  existingState: Uint8Array | null,
  incoming: Uint8Array,
): { finalState: Buffer; usedUnion: boolean } {
  if (!existingState) {
    return { finalState: Buffer.from(incoming), usedUnion: false }
  }
  const incomingDoc = new Y.Doc()
  Y.applyUpdate(incomingDoc, incoming)
  const surplus = Y.diffUpdate(existingState, Y.encodeStateVector(incomingDoc))
  if (isEmptyUpdate(surplus)) {
    // incoming ⊇ existing => union === incoming; skip the re-encode.
    return { finalState: Buffer.from(incoming), usedUnion: false }
  }
  // Concurrency detected: union-merge fallback to never lose edits.
  const doc = new Y.Doc()
  Y.applyUpdate(doc, existingState)
  Y.applyUpdate(doc, incoming)
  return { finalState: Buffer.from(Y.encodeStateAsUpdate(doc)), usedUnion: true }
}

export const persistence = {
  /**
   * fetch(documentName): full binary state (Uint8Array) or null (§3.2).
   * documentName is the canonical persistence key, not doc_id.
   */
  async fetch(documentName: string): Promise<Uint8Array | null> {
    return yjsDocumentRepo.fetchState(documentName)
  },

  /**
   * store(documentName, incoming, context): persist the full merged state.
   * merge-on-write (union) is the correctness fallback; the diffUpdate bypass
   * skips the redundant union re-encode on the normal single-writer path.
   */
  async store(documentName: string, incoming: Uint8Array, context?: StoreContext): Promise<void> {
    // §9.5 single-document hard size cap: reject oversized writes (a runaway
    // doc would block the event loop in decode/encode under the row lock).
    if (incoming.length > config.maxDocBytes) {
      throw new Error(
        `document ${documentName} exceeds max size ${config.maxDocBytes} bytes (got ${incoming.length})`,
      )
    }

    await transaction(async (tx) => {
      // 1. lock + take the latest row (read-modify-write 2nd-layer defense).
      const existingState = await yjsDocumentRepo.selectForUpdateTx(tx, documentName)

      // 2. merge-on-write + diffUpdate bypass.
      const { finalState } = computeFinalState(existingState, incoming)

      // 3. UPSERT single authoritative row.
      await yjsDocumentRepo.upsertStateTx(tx, documentName, finalState)

      // doc_meta.updated_at + updated_by (updated_by from context.user.id, §4.1).
      await tx.query('UPDATE doc_meta SET updated_at = NOW(3), updated_by = ? WHERE document_name = ?', [
        context?.user?.id ?? null,
        documentName,
      ])
    })
  },
}
