/**
 * Live-document side of version restore (§4 feature #4, design §7.3).
 *
 * The DB-bound half (safety snapshot, role/epoch recheck, doc_meta) runs in the
 * restoreVersion service. This module performs the SECOND, indispensable half:
 * applying the reconcile onto the LIVE Hocuspocus document so connected clients
 * see the restore in real time — and so the restore is the single authoritative
 * content write, never clobbered by a stale client's union.
 *
 * Why this is the only correct content-write path (the Bug B fix):
 *   - openDirectConnection returns the SAME in-memory Y.Doc the connected tabs
 *     are editing. reconcileFragment inside connection.transact issues REAL Yjs
 *     deletes/inserts on that doc's struct store, so deletions become causal
 *     tombstones every client converges to (Hocuspocus broadcasts the update +
 *     publishes it over extension-redis to other nodes).
 *   - Because the live doc itself carries the deletions forward, its next store
 *     is on the union-safe direction (incoming ⊇ existing in persistence.store),
 *     so the diffUpdate bypass — not the union fallback — runs and the deleted
 *     content is NOT resurrected.
 *   - A second, separately computed yjs_document write (a transient-doc encode)
 *     would carry a DIFFERENT clientId and therefore force the union fallback on
 *     the live doc's next store, doubling the restored content. So restore must
 *     NOT write yjs_document directly; this path is authoritative.
 *
 * disconnect() (unloadImmediately default) flushes onStoreDocument with debounce
 * 0 and is awaited, so the restored state is durably persisted before we return.
 */
import type { Document } from '@hocuspocus/server'
import type * as Y from 'yjs'
import { getCollabServer } from './server.js'
import { decodeTargetSnapshot, reconcileFragment, reconcileSheetMap } from './versionRestore.js'
import { advanceEditVersion } from './liveDocWrite.js'
import { COLLAB_FIELD } from '../schema/index.js'
import type { Node as PMNode } from 'prosemirror-model'

/**
 * Reconcile a restore's content onto a live doc, in place. MUST run inside the
 * doc's transaction so the deletions land as causal tombstones on the live struct
 * store. Shared between the live apply (applyRestoreToLiveDoc) and the unit tests
 * so the exact production sequence is covered without a live Hocuspocus server.
 *
 * The trailing advanceEditVersion is the P1 fix (mirrors commitLiveEdit /
 * commitLiveSheetEdit): a restore is a content WRITE, so its base-version token
 * must move forward even when the restore only DELETES. A delete-only reconcile
 * (rolling a sheet/doc back to a state with fewer cells or nodes) records only
 * tombstones, and Y.encodeStateVector tracks each client's insert clock, not
 * deletions — so without the bump the state vector was byte-identical after the
 * restore. That silently broke the two consumers of the token:
 *   - an in-flight sheet paginated read: its cursor embeds the pre-restore
 *     baseVersion; with the SV unchanged the drift guard failed to fire, so pages
 *     served before and after the restore stitched together an inconsistent grid
 *     instead of returning 409 sheet_changed.
 *   - the sheet/doc write guard: a bot could reuse its pre-restore baseVersion to
 *     slip a stale write past the If-Match optimistic-concurrency check.
 * Advancing a doc-private counter integrates one new struct on the acting doc's
 * clock, so the SV moves forward on a delete-only restore just like on a set.
 */
export function reconcileRestoreOntoDoc(doc: Y.Doc, targetPMDoc: PMNode, targetState: Uint8Array): void {
  const fragment = doc.getXmlFragment(COLLAB_FIELD)
  reconcileFragment(targetPMDoc, fragment)
  // Spreadsheet cells + dims live in their own Y.Maps, not the fragment — restore
  // them onto the same live doc so connected clients converge on the restored
  // grid. No-op for a text document (it has no 'sheet' map).
  reconcileSheetMap(doc, targetState)
  // Advance the base-version token so a delete-only restore is still detected by
  // the read cursor / write guards (see the doc comment above).
  advanceEditVersion(doc)
}

/**
 * Apply a target version's content onto the live document and broadcast it.
 *
 * @param documentName canonical persistence/connection key for the document
 * @param uid          acting user id (becomes doc_meta.updated_by on store)
 * @param targetState  the target snapshot's raw Yjs bytes
 *
 * Throws SchemaIncompatibleError if the target cannot load under the current
 * schema (the caller validates this before mutating any state).
 */
export async function applyRestoreToLiveDoc(
  documentName: string,
  uid: string,
  targetState: Uint8Array,
): Promise<void> {
  const targetPMDoc = decodeTargetSnapshot(targetState)
  const server = getCollabServer()

  // openDirectConnection attaches to the document's single live in-memory copy
  // (loading it from DB if no client is connected). It bypasses onAuthenticate,
  // so authorization MUST already have been enforced by the caller (the restore
  // service rechecks admin + permission_epoch under the row lock).
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  try {
    await connection.transact((doc: Document) => {
      reconcileRestoreOntoDoc(doc, targetPMDoc, targetState)
    })
  } finally {
    // Flushes the final store (awaited) and releases the direct connection.
    await connection.disconnect()
  }
}
