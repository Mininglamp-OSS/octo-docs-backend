/**
 * Live-document side of a bot board-scene edit (mirrors liveSheetWrite.ts /
 * liveDocWrite.ts). Two halves: a read-only snapshot for the GET / pre-flight,
 * and the guarded commit that performs the single authoritative scene write onto
 * the LIVE Hocuspocus board document.
 *
 * openDirectConnection returns the SAME in-memory Y.Doc the connected clients are
 * editing and bypasses onAuthenticate / beforeHandleMessage (server-internal, no
 * ctx). So the CALLER must authorize first — editBoardScene rechecks role +
 * permission_epoch under the row lock, exactly as the sheet/doc write services do.
 *
 * The state-vector guard is the FIRST statement inside the transact and the scene
 * mutation is the LAST, so a drift between the caller's GET /:docId/scene and this
 * commit throws BaseVersionStaleError BEFORE any mutation or broadcast (never a
 * silent last-writer-wins). The compared token is `clientBaseVersion` — the value
 * the caller read — not a re-read of this run's own state vector.
 */
import type { Document } from '@hocuspocus/server'
import * as Y from 'yjs'
import { getCollabServer } from './server.js'
import { advanceEditVersion } from './liveDocWrite.js'
import { stateVectorsEqual, BaseVersionStaleError } from './docBodyEdit.js'
import { applyBoardOpsToDoc, type ValidatedBoardOps } from '../whiteboard/boardEdit.js'

/**
 * Read the live board document for a scene read (mirrors readLiveSheet).
 * Returns the current authoritative Y.Doc binary state and its state vector,
 * read inside a single transact for a consistent view. Read-only.
 */
export async function readLiveBoard(
  documentName: string,
): Promise<{ state: Uint8Array; baseSV: Uint8Array }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: 'system' } })
  let state!: Uint8Array
  let baseSV!: Uint8Array
  try {
    await connection.transact((doc: Document) => {
      state = Y.encodeStateAsUpdate(doc)
      baseSV = Y.encodeStateVector(doc)
    })
  } finally {
    await connection.disconnect()
  }
  return { state, baseSV }
}

/**
 * Commit a validated scene edit batch onto the live board document under the
 * client base-version guard, and broadcast it (mirrors commitLiveSheetEdit).
 *
 * advanceEditVersion (shared with the doc/sheet paths) bumps a doc-private
 * counter so a delete-only tombstone batch also moves the state vector forward;
 * without it a batch that only sets `isDeleted` could leave the base-version
 * token reusable.
 *
 * disconnect() (awaited) flushes onStoreDocument, which re-caps the size and
 * re-stamps doc_meta.updated_by from the acting uid.
 */
export async function commitLiveBoardEdit(
  documentName: string,
  uid: string,
  clientBaseVersion: Uint8Array,
  ops: ValidatedBoardOps,
): Promise<{ newSV: Uint8Array; bytes: number }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  let newSV!: Uint8Array
  let bytes = 0
  try {
    await connection.transact((doc: Document) => {
      // (1) PRIMARY guard — first statement, before any mutation. A drift since
      //     the caller's read throws with no write/broadcast (fail-closed).
      const currentSV = Y.encodeStateVector(doc)
      if (!stateVectorsEqual(clientBaseVersion, currentSV)) {
        throw new BaseVersionStaleError()
      }
      // (2) The single, last content mutation. applyBoardOpsToDoc only touches
      //     the ids named in the batch (element-level upsert/delete, CAS-guarded).
      applyBoardOpsToDoc(doc, ops)
      // (3) Advance the edit-version counter so a delete-only tombstone batch also
      //     moves the state vector forward; the token is read AFTER this bump.
      advanceEditVersion(doc)
      newSV = Y.encodeStateVector(doc)
      bytes = Y.encodeStateAsUpdate(doc).length
    })
  } finally {
    // Flushes the final store (awaited) and releases the direct connection.
    await connection.disconnect()
  }
  return { newSV, bytes }
}
