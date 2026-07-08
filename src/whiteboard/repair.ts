/**
 * Server-authoritative whiteboard repair (XIN-16 §4 / XIN-14 §3.3).
 *
 * The back-end is the SINGLE authoritative writer of repair results. Repair runs
 * on the owner node's one live in-memory Y.Doc inside a `REPAIR_ORIGIN`
 * transaction; the front-end binding only does local, render-time normalize and
 * NEVER writes its result back (§4.2).
 *
 * Three anti-self-excitation gates (§4.1), so repair never feeds itself:
 *   1. origin skip   — the observer ignores transactions whose origin is
 *                      REPAIR_ORIGIN (repair's own corrective writes).
 *   2. diff-empty    — an element is rewritten only if its normalized form
 *                      differs from the current value field-by-field; a clean
 *                      doc produces NO transaction at all (idempotent:
 *                      normalize(normalize(x)) === normalize(x)).
 *   3. changed-keys  — the live observer scopes normalization to the element ids
 *                      that actually changed in the triggering transaction,
 *                      rather than rescanning the whole board.
 *
 * Determinism (BE-M11): `repairWhiteboardState` builds a fresh Y.Doc with the
 * fixed REPAIR_CLIENT_ID and applies a fully deterministic plan (sorted ids,
 * sorted field writes, deterministic index fill, no randomness/clock), so N
 * independent instances repairing the same illegal input emit byte-identical
 * `encodeStateAsUpdate`. See test/whiteboardRepairDeterminism.test.ts.
 */
import * as Y from 'yjs'
import {
  normalizeElement,
  REPAIR_ORIGIN,
  REPAIR_CLIENT_ID,
  FILE_BEARING_TYPES,
} from './schema/index.js'
import type { WhiteboardElement } from './schema/index.js'
import { getElementsMap, getFilesMap, readEntry, readElements, type YElements } from './ydoc.js'

/** Deterministic fractional-index key for an element that lacks a valid one. */
function fillIndexKey(seq: number): string {
  // base36, zero-padded — valid INDEX_RE charset, stable sort order, no clock.
  return `r${seq.toString(36).padStart(8, '0')}`
}

/** Deep-ish equality good enough for element field values (primitives + JSON). */
function fieldEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // NaN is never === itself, so the strict check above misses NaN/NaN. Treat two
  // NaNs as equal (Object.is semantics) — otherwise a surviving NaN in a
  // passed-through unknown field would fail both the diff-empty gate and the
  // per-field write guard, so repair would emit a corrective write on every pass
  // and never converge (breaks idempotence + BE-M11 determinism).
  if (a !== a && b !== b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

interface RepairPlan {
  /** element id -> canonical field object to converge to. */
  writes: Map<string, Record<string, unknown>>
  /** element ids to delete (unrenderable: bad id/type or dangling image). */
  drops: string[]
  /** fileIds to GC (no surviving image element references them). */
  fileGc: string[]
}

/**
 * Fileset GC policy for a repair pass (P1-1). Image elements and their `files`
 * entries can legitimately be inserted across TWO separate transactions (element
 * in txn A, file in txn B, or vice versa — the FE binding does not guarantee an
 * atomic file+element commit). At the scoped repair tick BETWEEN those two
 * transactions one side is not yet visible, so a naive GC that fires on mere
 * absence destroys a just-inserted image/file whose counterpart is still in
 * flight. GC must therefore act only on POSITIVE DELETE EVIDENCE, never on
 * absence alone:
 *
 *   'coldStart'  — the whole persisted state is materialized at once (cold-start
 *                  / failover / whole-board pass): nothing is in flight, so an
 *                  absent-file image really is dangling and an unreferenced file
 *                  really is orphaned — drop / GC both. Deterministic (BE-M11).
 *   'none'       — a live insert/update or element-deletion pass: never drop an
 *                  image for an absent file and never GC a file. An absent
 *                  counterpart may simply not have arrived yet.
 *   Set<string>  — a live FILE-DELETION pass: the set holds the fileIds just
 *                  removed in the triggering transaction. Drop only images whose
 *                  fileId is in this set; GC no other file. A pending image whose
 *                  (not-yet-arrived) file is NOT in the set is left untouched.
 */
type FilePolicy = 'coldStart' | 'none' | ReadonlySet<string>

/**
 * Compute the repair plan from the current doc state. Pure read; performs no
 * writes. `scope` (when provided) limits which element ids are candidates for
 * normalize/drop — the live observer passes the changed ids (gate 3); the
 * cold-start path passes `null` to consider every element. `files` gates all
 * file-related GC on positive delete evidence (see FilePolicy, P1-1).
 */
function planRepair(
  doc: Y.Doc,
  scope: ReadonlySet<string> | null,
  files: FilePolicy,
): RepairPlan {
  const elements = getElementsMap(doc)
  const allIds = new Set(elements.keys())
  const fileIds = new Set(getFilesMap(doc).keys())
  const current = readElements(doc)

  // Should an image whose `fileId` is absent from the files container be DROPPED
  // this pass? Only on positive delete evidence (see FilePolicy). On insert
  // passes ('none') an absent file may just be a split-transaction insert that
  // has not landed yet, so the image is kept.
  const dropAbsentImage = (id: string): boolean => {
    const el = current.get(id)
    if (!el || !FILE_BEARING_TYPES.has(el.type as string)) return false
    const fid = el.fileId
    const absent = typeof fid !== 'string' || !fileIds.has(fid)
    if (!absent) return false
    if (files === 'coldStart') return true
    if (files === 'none') return false
    return typeof fid === 'string' && files.has(fid) // just-deleted file only
  }

  // Pass 1: decide survivors (drop bad id/type or a positively-dangling image)
  // over all ids, so reference pruning in pass 2 sees the correct surviving-id
  // set. The absent-file drop is decided by `dropAbsentImage` (NOT by passing
  // fileIds into normalizeElement) so a split-transaction insert is never GC'd
  // on mere absence (P1-1). A survivor whose tombstone flag is set
  // (isDeleted === true) keeps its key (§1.1) but is NOT a valid reference
  // target: `referenceable` is therefore the non-tombstoned subset, and it — not
  // `survivors` — is what pass 2 passes as elementIds so a ref to a tombstoned
  // element is pruned exactly like a ref to an absent one (M-5, types.ts
  // §elementIds = the non-tombstoned id set).
  const survivors = new Set<string>()
  const referenceable = new Set<string>()
  const dropAll: string[] = []
  for (const id of allIds) {
    const n = normalizeElement(current.get(id), {})
    if (n && !dropAbsentImage(id)) {
      survivors.add(id)
      if (n.isDeleted !== true) referenceable.add(id)
    } else {
      dropAll.push(id)
    }
  }

  // Deterministic index fill: indexless survivors (sorted by id) get a stable
  // synthetic key. Computed over ALL survivors so the assignment is identical
  // regardless of scope.
  const indexFill = new Map<string, string>()
  let seq = 0
  for (const id of [...survivors].sort()) {
    const el = current.get(id)!
    const n = normalizeElement(el, {})!
    if (n.index === undefined) indexFill.set(id, fillIndexKey(seq++))
  }

  const writes = new Map<string, Record<string, unknown>>()
  const candidates = scope ? [...survivors].filter((id) => scope.has(id)) : [...survivors]
  for (const id of candidates.sort()) {
    const el = current.get(id)!
    const n = normalizeElement(el, { elementIds: referenceable }) as WhiteboardElement
    const final: Record<string, unknown> = { ...n }
    const fill = indexFill.get(id)
    if (fill !== undefined) final.index = fill
    // diff-empty gate: only write when the canonical form differs from current.
    if (!objectEquals(current.get(id)!, final)) writes.set(id, final)
  }

  // File GC: a file with no surviving image element referencing it is dangling.
  // Only performed on a whole-board cold-start pass — never on a live insert
  // pass (a file whose image is a pending split-transaction insert must survive)
  // and never on a file-deletion pass (the removed files are already gone from
  // the map; their images are dropped via dropAbsentImage). See FilePolicy.
  const fileGc: string[] = []
  if (files === 'coldStart') {
    const referenced = new Set<string>()
    for (const id of survivors) {
      const el = current.get(id)!
      if (FILE_BEARING_TYPES.has(el.type as string) && typeof el.fileId === 'string') {
        referenced.add(el.fileId)
      }
    }
    for (const fid of [...fileIds].sort()) {
      if (!referenced.has(fid)) fileGc.push(fid)
    }
  }

  const drops = scope ? dropAll.filter((id) => scope.has(id)) : dropAll
  return { writes, drops: drops.sort(), fileGc }
}

function objectEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!(k in b) || !fieldEquals(a[k], b[k])) return false
  }
  return true
}

/**
 * Apply a repair plan to the live doc inside ONE REPAIR_ORIGIN transaction.
 * Writes are field-level on the per-element Y.Map (so concurrent edits to other
 * fields/elements survive). Returns true if anything was written. If the plan is
 * empty NO transaction is opened (gate 2 — no empty-transaction observe storm).
 */
function applyPlan(doc: Y.Doc, plan: RepairPlan): boolean {
  if (plan.writes.size === 0 && plan.drops.length === 0 && plan.fileGc.length === 0) {
    return false
  }
  const elements = getElementsMap(doc)
  const files = getFilesMap(doc)
  doc.transact(() => {
    // (a) field-level element rewrites, sorted by id then by field for byte
    //     determinism (struct creation order is encoding-significant).
    for (const id of [...plan.writes.keys()].sort()) {
      const final = plan.writes.get(id)!
      let yEl = elements.get(id)
      if (!(yEl instanceof Y.Map)) {
        yEl = new Y.Map()
        elements.set(id, yEl as Y.Map<unknown>)
      }
      const cur = readEntry(yEl)
      for (const f of Object.keys(final).sort()) {
        if (!fieldEquals(cur[f], final[f])) yEl.set(f, final[f])
      }
      for (const f of Object.keys(cur).sort()) {
        if (!(f in final)) yEl.delete(f)
      }
    }
    // (b) drop unrenderable elements.
    for (const id of plan.drops) elements.delete(id)
    // (c) GC dangling file references.
    for (const fid of plan.fileGc) files.delete(fid)
  }, REPAIR_ORIGIN)
  return true
}

/**
 * Repair the live in-memory doc. `scope` limits normalization to the changed
 * element ids (gate 3); pass `null` to consider the whole board. `files` gates
 * file GC on positive delete evidence (P1-1); it defaults to `'coldStart'` for a
 * whole-board pass (scope === null: nothing in flight, GC is safe) and to
 * `'none'` for a scoped live pass (an absent counterpart may be a
 * split-transaction insert still in flight). The file-deletion path passes an
 * explicit set of just-removed fileIds. Returns true if a corrective transaction
 * was written.
 */
export function repairLiveDoc(
  doc: Y.Doc,
  scope: ReadonlySet<string> | null = null,
  files: FilePolicy = scope === null ? 'coldStart' : 'none',
): boolean {
  return applyPlan(doc, planRepair(doc, scope, files))
}

/**
 * Choose the clientID repair's corrective structs are attributed under, AFTER
 * the input state has been loaded into `doc` (P1-2). The fixed REPAIR_CLIENT_ID
 * is the determinism lever for BE-M11 (new structs carry the same client on
 * every node), but it self-collides on RE-repair: a doc whose loaded state was
 * already produced by a prior repair generation ALREADY contains structs under
 * REPAIR_CLIENT_ID. If we pinned `doc.clientID = REPAIR_CLIENT_ID` before
 * loading such a state, Yjs would detect the collision on applyUpdate and
 * silently reassign a RANDOM clientID — so the gen-2 corrective writes land under
 * a per-node random id and two nodes diverge, defeating BE-M11.
 *
 * Instead we load first (with the doc's own throwaway random id, which cannot
 * collide with the reserved band in practice), then pick the highest reserved id
 * not already present in the loaded state: REPAIR_CLIENT_ID for a first-generation
 * repair (byte-identical to the previous behaviour), or the next id down for each
 * successive generation. The choice is a pure function of the loaded state, so it
 * is generation-stable AND identical across nodes — collision-free determinism.
 */
function chooseRepairClientId(doc: Y.Doc): number {
  const present = Y.decodeStateVector(Y.encodeStateVector(doc))
  let id = REPAIR_CLIENT_ID
  while (present.has(id) || id === doc.clientID) id -= 1
  return id
}

/**
 * Cold-start / failover repair (BE-M11). Materializes a canonical state from
 * `state` on a fresh Y.Doc, attributing repair's corrective structs to a
 * collision-free reserved clientID (chooseRepairClientId), so independent
 * instances produce byte-identical `encodeStateAsUpdate` — including on a SECOND
 * repair of an already-once-repaired doc (P1-2). Returns the canonical bytes and
 * whether repair changed anything.
 */
export function repairWhiteboardState(state: Uint8Array | null): {
  state: Uint8Array
  changed: boolean
} {
  const doc = new Y.Doc()
  // Load FIRST (the doc's throwaway random id will not collide with the loaded
  // structs), THEN pin a collision-free reserved clientID for repair's writes.
  // Pinning before load is what triggered Yjs's random-id reassignment on a
  // re-repair (the REPAIR_CLIENT_ID self-collision) and broke determinism.
  if (state && state.length > 0) Y.applyUpdate(doc, state)
  doc.clientID = chooseRepairClientId(doc)
  const changed = repairLiveDoc(doc, null)
  const out = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return { state: out, changed }
}

/**
 * True if element `id` is removed as a *reference target*: hard-deleted (key
 * gone from the elements map) or tombstoned (isDeleted === true). Mirrors the
 * `referenceable` set built in planRepair — a removed id must not keep any
 * dependent's containerId/frameId/boundElements alive (M-5).
 */
function isRemovedTarget(elements: YElements, id: string): boolean {
  const yEl = elements.get(id)
  if (!(yEl instanceof Y.Map)) return true // hard-deleted / never a proper element
  return yEl.get('isDeleted') === true // tombstoned
}

/**
 * Ids of surviving elements that reference any id in `removed` via
 * containerId / frameId / boundElements. Used to expand the live observer scope
 * on a delete so the dependents get re-normalized (their now-dangling refs
 * pruned) even though only the deleted id itself changed in the transaction.
 */
function referrersOf(doc: Y.Doc, removed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  if (removed.size === 0) return out
  for (const [id, el] of readElements(doc)) {
    if (removed.has(id)) continue
    if (typeof el.containerId === 'string' && removed.has(el.containerId)) {
      out.add(id)
      continue
    }
    if (typeof el.frameId === 'string' && removed.has(el.frameId)) {
      out.add(id)
      continue
    }
    if (
      Array.isArray(el.boundElements) &&
      (el.boundElements as Array<{ id?: unknown }>).some(
        (b) => b && typeof b.id === 'string' && removed.has(b.id),
      )
    ) {
      out.add(id)
    }
  }
  return out
}

/**
 * Load-path (cold-start / failover) repair of a LIVE doc (BE-M11).
 *
 * `repairLiveDoc` rewrites fields directly on the doc, so the corrective structs
 * are attributed to the doc's OWN clientID — which on a freshly loaded live doc
 * is the node's RANDOM clientID. Two nodes cold-repairing the same persisted
 * blob on failover would then emit DIFFERENT bytes (see the CONTROL case in
 * whiteboardRepairDeterminism.test.ts). afterLoadDocument must therefore route
 * the persisted-state convergence through the fixed-REPAIR_CLIENT_ID
 * materialization: compute the canonical state off the current bytes, then merge
 * it back under REPAIR_ORIGIN (gate 1 keeps the observer from re-firing). The
 * repair structs now carry REPAIR_CLIENT_ID identically on every node, so the
 * live docs converge byte-for-byte. Returns true if it changed the doc.
 */
export function coldRepairLiveDoc(doc: Y.Doc): boolean {
  const before = Y.encodeStateAsUpdate(doc)
  const { state, changed } = repairWhiteboardState(before.length > 0 ? before : null)
  if (!changed) return false
  Y.applyUpdate(doc, state, REPAIR_ORIGIN)
  return true
}

/**
 * Attach the repair observer to a live whiteboard doc (wired on document load,
 * §4.1). The observer skips its own REPAIR_ORIGIN writes (gate 1) and scopes
 * normalization to the changed element ids (gate 3). Returns a disposer.
 */
export function attachWhiteboardRepair(doc: Y.Doc): () => void {
  const elements = getElementsMap(doc)
  const files = getFilesMap(doc)

  const onElements = (events: Y.YEvent<Y.Map<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === REPAIR_ORIGIN) return // gate 1
    const changed = new Set<string>()
    for (const e of events) {
      // Top-level elements map change => keys are element ids; nested per-element
      // map change => the path's first segment is the element id.
      if (e.target === elements) {
        for (const id of e.keys.keys()) changed.add(id)
      } else if (e.path.length > 0 && typeof e.path[0] === 'string') {
        changed.add(e.path[0] as string)
      }
    }
    if (changed.size === 0) return
    // A delete (hard key removal OR tombstone flip) orphans elements that
    // reference the removed id. The scoped pass only sees the deleted id itself,
    // so expand the scope to its dependents; otherwise a surviving text whose
    // container was just deleted keeps its dangling containerId forever (M-5,
    // P1-3). Detect removals among the changed ids, then pull in their referrers.
    const removed = new Set<string>()
    for (const id of changed) {
      if (isRemovedTarget(elements, id)) removed.add(id)
    }
    for (const refId of referrersOf(doc, removed)) changed.add(refId)
    repairLiveDoc(doc, changed)
  }

  const onFiles = (events: Y.YEvent<Y.Map<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === REPAIR_ORIGIN) return // gate 1
    // Only a file DELETION can orphan an image element (its fileId now dangles).
    // A file INSERT must NOT trigger GC: the file may be the first half of a
    // split-transaction insert whose image element has not arrived yet — GCing
    // it here as "unreferenced" would destroy it before its element lands (P1-1).
    const deletedFiles = new Set<string>()
    for (const e of events) {
      if (e.target === files) {
        for (const [key, change] of e.keys) {
          if (change.action === 'delete') deletedFiles.add(key)
        }
      }
    }
    if (deletedFiles.size === 0) return
    // Drop exactly the images pointing at a just-deleted file (whole-board scope
    // so every referrer is caught); pass the deleted-file set so a pending image
    // whose not-yet-arrived file is NOT in the set is left untouched.
    repairLiveDoc(doc, null, deletedFiles)
  }

  elements.observeDeep(onElements)
  files.observeDeep(onFiles)
  return () => {
    elements.unobserveDeep(onElements)
    files.unobserveDeep(onFiles)
  }
}
