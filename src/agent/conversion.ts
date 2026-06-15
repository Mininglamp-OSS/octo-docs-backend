/**
 * Server-side (no-DOM) ProseMirror <-> Y.Doc conversion (§7.1).
 *
 * Uses y-prosemirror's pure functions, runnable in Node with no DOM. The schema
 * and COLLAB_FIELD come from the shared schema module — never hardcode 'default'
 * (§7.1 / appendix B). The server schema MUST match the front-end Tiptap config
 * exactly, or conversion corrupts / loses content.
 */
import * as Y from 'yjs'
import { prosemirrorToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema, COLLAB_FIELD } from '../schema/index.js'

const schema = buildSchema()

/** Read: Y.Doc binary state -> ProseMirror JSON (for an Agent to understand). */
export function yDocStateToProsemirrorJSON(state: Uint8Array): unknown {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  return yDocToProsemirrorJSON(ydoc, COLLAB_FIELD)
}

/** Read directly from a live Y.Doc. */
export function yDocToProsemirrorJSONField(ydoc: Y.Doc): unknown {
  return yDocToProsemirrorJSON(ydoc, COLLAB_FIELD)
}

/**
 * Write: ProseMirror JSON -> Y.Doc binary update.
 * Validates JSON against the schema first (throws on invalid shape).
 */
export function prosemirrorJSONToYDocState(pmJSON: unknown): Uint8Array {
  const node = PMNode.fromJSON(schema, pmJSON as Parameters<typeof PMNode.fromJSON>[1])
  const ydoc = prosemirrorToYDoc(node, COLLAB_FIELD)
  return Y.encodeStateAsUpdate(ydoc)
}

export { COLLAB_FIELD, schema }
