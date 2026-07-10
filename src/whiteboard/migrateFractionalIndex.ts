/**
 * XIN-794 — data migration for whiteboard docs carrying the legacy illegal
 * fractional-index key (`r`+base36, e.g. `r00000003`) that the pre-fix repair
 * `fillIndexKey` wrote back to persistence.
 *
 * This module holds the PURE, DB-free detection + repair logic so it is unit
 * testable; the CLI wrapper (scripts/repairFractionalIndices.ts) supplies the
 * MySQL read/write around it.
 *
 * A victim doc broadcasts its illegal key on every open; the FE binding throws
 * in updateScene and the render crashes. Fix ① (legal fillIndexKey) + ② (strict
 * isValidIndex) make the load-path repair strip + re-fill such a key on the next
 * cold-start, but a doc that is not reopened stays broken in storage. This
 * migration reverse-finds the victims and re-repairs their persisted state once.
 */
import * as Y from 'yjs'
import { getElementsMap, readEntry } from './ydoc.js'
import { repairWhiteboardState } from './repair.js'

/**
 * The exact shape of every synthetic key the pre-fix `fillIndexKey` produced:
 * `r` followed by 8 base36 (0-9a-z) characters (`r${seq.toString(36).padStart(8,
 * '0')}`). This is the reverse-find rule for victim docs (XIN-794 DoD). It is a
 * structurally invalid jitterbug key — head 'r' demands a 19-char integer part
 * but the string is only 9 chars — so a legitimately-generated Excalidraw key
 * can never match it.
 */
export const LEGACY_ILLEGAL_INDEX_RE = /^r[0-9a-z]{8}$/

/** True iff `idx` is the legacy illegal synthetic-key shape. */
export function isLegacyIllegalIndex(idx: unknown): idx is string {
  return typeof idx === 'string' && LEGACY_ILLEGAL_INDEX_RE.test(idx)
}

/**
 * Scan a persisted Y.Doc state for elements carrying a legacy illegal index.
 * Pure read: decodes into a throwaway doc and never mutates input. Returns the
 * matching element ids (empty => not a victim).
 */
export function findLegacyIllegalIndices(state: Uint8Array | null): string[] {
  const hits: string[] = []
  if (!state || state.length === 0) return hits
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    for (const [id, v] of getElementsMap(doc).entries()) {
      if (isLegacyIllegalIndex(readEntry(v).index)) hits.push(id)
    }
  } finally {
    doc.destroy()
  }
  return hits.sort()
}

/** Convenience predicate over {@link findLegacyIllegalIndices}. */
export function stateHasLegacyIllegalIndex(state: Uint8Array | null): boolean {
  return findLegacyIllegalIndices(state).length > 0
}

/**
 * Re-repair a victim doc's persisted bytes to legal fractional-index keys.
 * Routes through the same fixed-clientID materialization the cold-start path
 * uses (`repairWhiteboardState`), so the migrated bytes are byte-identical to
 * what the server would converge to on the next load (BE-M11), and re-running
 * the migration is a no-op. Returns the new bytes and whether anything changed.
 */
export function migrateState(state: Uint8Array | null): {
  state: Uint8Array
  changed: boolean
} {
  return repairWhiteboardState(state)
}
