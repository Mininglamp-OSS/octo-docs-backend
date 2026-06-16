/**
 * Version-restore core (§4 feature #4). Pure, DB-free helpers so the union-safe
 * restore mechanics and the schema forward-compat gate are unit-testable without
 * live infrastructure.
 *
 * Restore is a FORWARD, non-destructive operation on the live authoritative
 * state — never a CRDT rewind, and never a detached-doc union-merge (which would
 * trigger the computeFinalState union reback documented in persistence.ts). We
 * hydrate a Y.Doc from the CURRENT live state and reconcile the target version's
 * content INTO its fragment in-place, so the deletions become causal tombstones
 * on the live struct store. diffUpdate(live, sv(reconciled)) is then empty
 * (reconciled ⊇ live) and store() takes the direct-write bypass — no union.
 */
import * as Y from 'yjs'
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema, COLLAB_FIELD, SCHEMA_VERSION } from '../schema/index.js'

const schema = buildSchema()

/** Transaction origin tag for the in-place restore write (diagnostics). */
export const RESTORE_ORIGIN = 'version-restore'

/**
 * Raised when a target version cannot be loaded under the current schema (an
 * older snapshot referencing a node/mark the current schema no longer defines).
 * The route maps this to 409 `version_schema_incompatible`.
 */
export class SchemaIncompatibleError extends Error {
  readonly code = 'version_schema_incompatible'
  constructor(cause?: unknown) {
    super('version_schema_incompatible')
    this.name = 'SchemaIncompatibleError'
    if (cause !== undefined) this.cause = cause
  }
}

export type SchemaGateResult = { ok: true } | { ok: false; status: number; code: string }

/**
 * Forward-compat gate (the "newer" half — pure / synchronous): a snapshot taken
 * under a NEWER schema than this server runs cannot be safely loaded =>
 * 409 `version_schema_newer`. The OLDER-but-unloadable case is detected at load
 * time (SchemaIncompatibleError) since it depends on the actual content.
 */
export function gateSchema(
  targetSchemaVersion: number,
  currentSchemaVersion: number = SCHEMA_VERSION,
): SchemaGateResult {
  if (targetSchemaVersion > currentSchemaVersion) {
    return { ok: false, status: 409, code: 'version_schema_newer' }
  }
  return { ok: true }
}

/**
 * Reconcile the target version's content into a doc hydrated from the current
 * live state, returning the full encoded state to persist.
 *
 * `liveState` MUST be the current authoritative state (not a blank doc) so the
 * result is a forward continuation: the in-place reconcile records deletions as
 * tombstones relative to live, keeping the write on the union-safe direction.
 *
 * Throws SchemaIncompatibleError if the target content does not load under the
 * current schema.
 */
export function restoreReconcile(liveState: Uint8Array | null, targetState: Uint8Array): Uint8Array {
  // Decode the target snapshot into a ProseMirror doc under the current schema.
  let targetPMDoc: PMNode
  try {
    const targetYDoc = new Y.Doc()
    Y.applyUpdate(targetYDoc, targetState)
    const targetJSON = yDocToProsemirrorJSON(targetYDoc, COLLAB_FIELD)
    targetPMDoc = PMNode.fromJSON(schema, targetJSON as Parameters<typeof PMNode.fromJSON>[1])
    // check() surfaces content-expression violations that fromJSON alone misses.
    targetPMDoc.check()
  } catch (err) {
    throw new SchemaIncompatibleError(err)
  }

  // Hydrate from the live state so the reconcile is a forward edit on the
  // authoritative instance, not a rebuild of a blank doc.
  const liveDoc = new Y.Doc()
  if (liveState) Y.applyUpdate(liveDoc, liveState)
  const liveFragment = liveDoc.get(COLLAB_FIELD, Y.XmlFragment)

  // In-place structural diff/reconcile (matches prefix/suffix, deletes+inserts
  // only the differing middle). Wrapped in a single transact on the live doc so
  // the deletions land as causal tombstones — DO NOT build a separate doc and
  // union it (that path triggers the union reback).
  liveDoc.transact(() => {
    prosemirrorToYXmlFragment(targetPMDoc, liveFragment)
  }, RESTORE_ORIGIN)

  return Y.encodeStateAsUpdate(liveDoc)
}
