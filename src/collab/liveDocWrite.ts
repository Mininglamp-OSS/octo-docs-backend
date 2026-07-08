/**
 * Live-document side of a bot incremental body edit (design §3.2, mirrors
 * liveRestore.ts). Two halves: a read-only snapshot for the pre-flight, and the
 * guarded commit that performs the single authoritative content write onto the
 * LIVE Hocuspocus document.
 *
 * openDirectConnection returns the SAME in-memory Y.Doc the connected clients are
 * editing and bypasses onAuthenticate / beforeHandleMessage (server-internal, no
 * ctx). So the CALLER must authorize first — editDocBody rechecks role +
 * permission_epoch under the row lock, exactly as the restore service does.
 *
 * The load-bearing correction (design item 1): the optimistic-concurrency guard
 * compares the CLIENT-supplied base version (the SV the bot read from GET
 * /content) against the live state vector INSIDE the same transact that performs
 * the reconcile, before any mutation. A drift between the bot's read and this
 * commit therefore throws BEFORE any write or broadcast (fail-closed) — never a
 * silent last-writer-wins.
 */
import type { Document } from '@hocuspocus/server'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import { Node as PMNode, type Schema } from 'prosemirror-model'
import { getCollabServer } from './server.js'
import { reconcileFragment } from './versionRestore.js'
import { COLLAB_FIELD } from '../schema/index.js'
import {
  applyIncrementalOps,
  stateVectorsEqual,
  BaseVersionStaleError,
  schema as sharedSchema,
  type DocEditOp,
} from './docBodyEdit.js'

/**
 * Doc-private field holding the monotonic edit-version counter (defect ②). It is
 * a top-level Y.Map, deliberately NOT the ProseMirror COLLAB_FIELD fragment, so
 * it never appears in GET content, conversion, or version restore (all of which
 * read only COLLAB_FIELD).
 */
export const EDIT_VERSION_FIELD = '__editVersion'

/**
 * Advance the doc's edit-version counter so EVERY committed edit moves the state
 * vector forward — including a delete-only edit (defect ②).
 *
 * A pure delete records only tombstones, and Y.encodeStateVector tracks each
 * client's *insert* clock, not deletions, so a delete-only reconcile leaves the
 * state vector byte-identical. The baseVersion token is that state vector, so
 * without this the token was unchanged after a delete and a client could reuse
 * its pre-delete token to slip a stale write past the optimistic-concurrency
 * guard (delete then insert with the old token both returned 200). Incrementing
 * a counter integrates one new struct on the acting doc's clock, so the state
 * vector advances on insert, replace, AND delete-only alike; the old token then
 * fails the guard with 412. Clocks only grow, so the marker is GC-stable.
 */
function advanceEditVersion(doc: Y.Doc): void {
  const meta = doc.getMap(EDIT_VERSION_FIELD)
  const current = meta.get('n')
  meta.set('n', (typeof current === 'number' ? current : 0) + 1)
}

/**
 * Read the live document for editing: its ProseMirror doc, the base state vector
 * the pre-flight compares the client token against, and the raw pre-edit state
 * (the size-gate hydration source and the safety-snapshot bytes). Read-only —
 * opens a direct connection, reads inside a transact for a consistent view, and
 * disconnects without mutating.
 */
export async function readLiveForEdit(
  documentName: string,
): Promise<{ pmDoc: PMNode; baseSV: Uint8Array; preEditState: Uint8Array }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: 'system' } })
  let pmDoc!: PMNode
  let baseSV!: Uint8Array
  let preEditState!: Uint8Array
  try {
    await connection.transact((doc: Document) => {
      pmDoc = PMNode.fromJSON(
        sharedSchema,
        yDocToProsemirrorJSON(doc, COLLAB_FIELD) as Parameters<typeof PMNode.fromJSON>[1],
      )
      baseSV = Y.encodeStateVector(doc)
      preEditState = Y.encodeStateAsUpdate(doc)
    })
  } finally {
    await connection.disconnect()
  }
  return { pmDoc, baseSV, preEditState }
}

/**
 * Commit the op batch onto the live document under the client base-version guard.
 *
 * The state-vector guard is the FIRST statement inside the transact and
 * reconcileFragment is the LAST mutation, so a drift between the client's GET and
 * this commit throws (BaseVersionStaleError) before any mutation or broadcast.
 * The compared token is `clientBaseVersion` — the value the bot read — not a
 * re-read of this run's own SV (design item 1).
 *
 * disconnect() (awaited) flushes onStoreDocument, which re-caps the size
 * (persistence.store) and re-stamps doc_meta.updated_by from the acting uid.
 */
export async function commitLiveEdit(
  documentName: string,
  uid: string,
  clientBaseVersion: Uint8Array,
  ops: DocEditOp[],
  schema: Schema,
): Promise<{ newSV: Uint8Array; bytes: number }> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  let newSV!: Uint8Array
  let bytes = 0
  try {
    await connection.transact((doc: Document) => {
      // (1) PRIMARY guard — first statement, before any read of content or mutation.
      const currentSV = Y.encodeStateVector(doc)
      if (!stateVectorsEqual(clientBaseVersion, currentSV)) {
        throw new BaseVersionStaleError()
      }
      // (2) Build the PM doc from the GUARDED live fragment (== what the bot addressed).
      const fragment = doc.getXmlFragment(COLLAB_FIELD)
      const currentDoc = PMNode.fromJSON(
        schema,
        yDocToProsemirrorJSON(doc, COLLAB_FIELD) as Parameters<typeof PMNode.fromJSON>[1],
      )
      // (3) Resolve anchors + apply ops (still pre-mutation; throws map to 4xx).
      const newDoc = applyIncrementalOps(currentDoc, ops, schema)
      // (4) The single, last content mutation.
      reconcileFragment(newDoc, fragment)
      // (5) Advance the edit-version counter so a delete-only edit also moves the
      //     state vector forward (defect ②); the token is read AFTER this bump.
      advanceEditVersion(doc)
      newSV = Y.encodeStateVector(doc)
      bytes = Y.encodeStateAsUpdate(doc).length
    })
  } finally {
    // Awaited flush -> persistence.store (re-caps + re-stamps updated_by).
    await connection.disconnect()
  }
  return { newSV, bytes }
}
