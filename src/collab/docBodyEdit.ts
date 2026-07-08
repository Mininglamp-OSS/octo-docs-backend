/**
 * Incremental document-body edit core (design §1.5 / §1.6 / §3.1). Pure,
 * DB-free, no live infrastructure — every anchor-resolution, transform and
 * boundary rule below is unit-testable in isolation (see test/docBodyEdit.test.ts).
 *
 * The write primitive is NOT a new Yjs splice: an incremental edit computes the
 * NEW full ProseMirror document (old doc + a localized transform) and hands it to
 * the same reconcileFragment restore uses. Because only the touched region
 * differs, the reconcile produces a minimal delta (design §0). So this module's
 * job is purely: resolve block-path anchors -> apply ops as one prosemirror
 * Transform -> validate the result, all before any live mutation.
 *
 * Correctness rests on the mandatory client base-version guard (§4, enforced in
 * liveDocWrite.commitLiveEdit): between the bot's GET and the committed write the
 * content is provably identical to what the bot addressed, so a block path
 * resolved against that unchanged doc cannot drift.
 */
import * as Y from 'yjs'
import { Node as PMNode, type Schema } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { buildSchema, COLLAB_FIELD } from '../schema/index.js'
import { reconcileFragment, SchemaIncompatibleError } from './versionRestore.js'

/**
 * The single shared schema instance for the whole doc-body-edit feature. A
 * prosemirror Transform compares NodeType by identity, so the doc being
 * transformed and the op `content` nodes MUST come from the same Schema
 * instance — hence one exported instance reused by liveDocWrite + editDocBody,
 * never a per-call buildSchema() (which would mint a fresh, non-identical type
 * set and break tr.insert/replaceWith content matching).
 */
export const schema: Schema = buildSchema()

// ── op contract (§1.4) ────────────────────────────────────────────────────────

/** A block path: child indices from the doc root down to the addressed node. */
export type BlockPath = number[]

/** Where an `insert` op places its content relative to the addressed block. */
export type InsertPosition = 'before' | 'after' | 'inside_start' | 'inside_end'

/** Lightweight anchor fingerprint so a bad anchor fails loudly (§1.2). */
export interface AnchorExpect {
  type?: string
}

export interface InsertOp {
  type: 'insert'
  at: { path: BlockPath; position: InsertPosition }
  expect?: AnchorExpect
  content: unknown[]
}

export interface ReplaceOp {
  type: 'replace'
  range: { from: { path: BlockPath }; to: { path: BlockPath } }
  expect?: AnchorExpect
  content: unknown[]
}

export interface DeleteOp {
  type: 'delete'
  range: { from: { path: BlockPath }; to: { path: BlockPath } }
  expect?: AnchorExpect
}

export type DocEditOp = InsertOp | ReplaceOp | DeleteOp

// ── error classes (mapped to HTTP in the route/service) ─────────────────────────

/** Path out of range / resolves to a non-block where a block is required (422). */
export class AnchorNotFoundError extends Error {
  readonly code = 'anchor_not_found'
  constructor(message = 'anchor_not_found') {
    super(message)
    this.name = 'AnchorNotFoundError'
  }
}

/** `expect.type` (or content fingerprint) does not match the addressed node (422). */
export class AnchorMismatchError extends Error {
  readonly code = 'anchor_mismatch'
  constructor(message = 'anchor_mismatch') {
    super(message)
    this.name = 'AnchorMismatchError'
  }
}

/**
 * Structurally invalid op set: overlapping/cross-parent ranges, `from > to`, or
 * two inserts at the identical `(path, position)` anchor (§1.4 item 2) (422).
 */
export class InvalidOpsError extends Error {
  readonly code = 'invalid_ops'
  constructor(message = 'invalid_ops') {
    super(message)
    this.name = 'InvalidOpsError'
  }
}

/** Client `baseVersion` (If-Match) does not equal the live state vector (412). */
export class BaseVersionStaleError extends Error {
  readonly code = 'base_version_stale'
  constructor(message = 'base_version_stale') {
    super(message)
    this.name = 'BaseVersionStaleError'
  }
}

export { SchemaIncompatibleError }

// ── base-version (Y state vector) codec (§4) ────────────────────────────────────

/** Encode a Y state vector as a base64 string (the `baseVersion` token). */
export function encodeBaseVersion(sv: Uint8Array): string {
  return Buffer.from(sv).toString('base64')
}

/** Decode a base64 `baseVersion` token back to a Y state vector. */
export function parseBaseVersion(raw: string): Uint8Array {
  return new Uint8Array(Buffer.from(raw, 'base64'))
}

/** Byte-exact equality of two Y state vectors (the optimistic-concurrency guard). */
export function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ── anchor resolution (§1.5 step 1) ─────────────────────────────────────────────

/**
 * Resolve a block path to its addressed node and absolute ProseMirror positions.
 * Descends `PMNode.child` accumulating `nodeSize`; `start` is the position of the
 * node's open token (or a leaf's start), `end` is the position immediately after
 * its close token. A missing / out-of-range index throws AnchorNotFoundError.
 */
export function resolveBlockPath(
  doc: PMNode,
  path: BlockPath,
): { node: PMNode; start: number; end: number } {
  if (!Array.isArray(path) || path.length === 0) {
    throw new AnchorNotFoundError('empty path')
  }
  let node = doc
  // Content of the top `doc` node starts at position 0 (no surrounding tokens);
  // content of any nested node starts one past its own open token.
  let contentStart = 0
  let start = 0
  for (const rawIdx of path) {
    if (!Number.isInteger(rawIdx) || rawIdx < 0 || rawIdx >= node.childCount) {
      throw new AnchorNotFoundError(`index ${String(rawIdx)} out of range`)
    }
    let offset = contentStart
    for (let i = 0; i < rawIdx; i++) {
      offset += node.child(i).nodeSize
    }
    node = node.child(rawIdx)
    start = offset
    contentStart = start + 1
  }
  return { node, start, end: start + node.nodeSize }
}

/** Absolute insertion position for an `insert` op relative to its anchor. */
function insertionPos(
  anchor: { start: number; end: number },
  position: InsertPosition,
): number {
  switch (position) {
    case 'before':
      return anchor.start
    case 'after':
      return anchor.end
    case 'inside_start':
      return anchor.start + 1
    case 'inside_end':
      return anchor.end - 1
    default:
      throw new InvalidOpsError(`unknown insert position ${String(position)}`)
  }
}

/** Assert an `expect` fingerprint matches the addressed node (§1.2). */
function checkExpect(node: PMNode, expect: AnchorExpect | undefined): void {
  if (expect?.type !== undefined && node.type.name !== expect.type) {
    throw new AnchorMismatchError(`expected ${expect.type}, found ${node.type.name}`)
  }
}

/** Parse an op's `content` into schema-validated block nodes (unknown -> 422). */
function parseContent(content: unknown, schema: Schema): PMNode[] {
  if (!Array.isArray(content) || content.length === 0) {
    throw new InvalidOpsError('content must be a non-empty array')
  }
  try {
    return content.map((json) =>
      PMNode.fromJSON(schema, json as Parameters<typeof PMNode.fromJSON>[1]),
    )
  } catch (err) {
    throw new SchemaIncompatibleError(err)
  }
}

/** The parent-path portion of a block path (everything but the last index). */
function parentPath(path: BlockPath): BlockPath {
  return path.slice(0, -1)
}

interface ResolvedOp {
  kind: 'insert' | 'replace' | 'delete'
  /** sort key: apply in descending order so earlier edits never shift later ones. */
  sortPos: number
  from: number
  to: number
  nodes?: PMNode[]
  /** identity key for the duplicate-same-anchor-insert guard. */
  insertKey?: string
}

/** Resolve a `range` (same parent, from <= to) to absolute positions (§1.6). */
function resolveRange(
  doc: PMNode,
  range: { from: { path: BlockPath }; to: { path: BlockPath } },
): { fromNode: PMNode; fromPos: number; toPos: number } {
  const fromPath = range.from?.path
  const toPath = range.to?.path
  if (!Array.isArray(fromPath) || !Array.isArray(toPath) || fromPath.length === 0 || toPath.length === 0) {
    throw new InvalidOpsError('range requires from.path and to.path')
  }
  const fp = parentPath(fromPath)
  const tp = parentPath(toPath)
  if (fp.length !== tp.length || fp.some((v, i) => v !== tp[i])) {
    throw new InvalidOpsError('range endpoints must share a parent')
  }
  const fromLast = fromPath[fromPath.length - 1]!
  const toLast = toPath[toPath.length - 1]!
  if (fromLast > toLast) {
    throw new InvalidOpsError('range from > to')
  }
  const fromRes = resolveBlockPath(doc, fromPath)
  const toRes = resolveBlockPath(doc, toPath)
  return { fromNode: fromRes.node, fromPos: fromRes.start, toPos: toRes.end }
}

/** Reject overlapping range ops and inserts landing strictly inside a range. */
function detectOverlaps(resolved: ResolvedOp[]): void {
  const ranges = resolved.filter((r) => r.kind !== 'insert')
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!
      const b = ranges[j]!
      if (a.from < b.to && b.from < a.to) {
        throw new InvalidOpsError('overlapping ranges')
      }
    }
  }
  for (const ins of resolved) {
    if (ins.kind !== 'insert') continue
    for (const r of ranges) {
      if (ins.from > r.from && ins.from < r.to) {
        throw new InvalidOpsError('insert lands inside a replaced/deleted range')
      }
    }
  }
}

/**
 * Apply the op batch onto `currentDoc` and return the new full document (§1.5).
 * Every anchor / range / content check runs BEFORE the first mutation; the
 * prosemirror Transform is applied in descending start order so no remapping is
 * needed, and `newDoc.check()` surfaces content-expression violations that
 * `fromJSON` alone misses. Throws (never partially mutates) on any violation.
 */
export function applyIncrementalOps(currentDoc: PMNode, ops: DocEditOp[], schema: Schema): PMNode {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new InvalidOpsError('no ops')
  }

  const resolved: ResolvedOp[] = []
  for (const op of ops) {
    if (op.type === 'insert') {
      if (!op.at || !Array.isArray(op.at.path)) throw new InvalidOpsError('insert requires at.path')
      let pos: number
      let node: PMNode
      if (op.at.path.length === 0) {
        // Root-container insert: the empty path addresses the doc root itself.
        // Legal ONLY for inside_start / inside_end (insert as the doc's first /
        // last child) — this is the sole way to write the first block into an
        // empty document, where there is no existing child to anchor a
        // before/after against. before/after against the root have no
        // meaningful sibling position and stay rejected (AnchorNotFoundError).
        if (op.at.position !== 'inside_start' && op.at.position !== 'inside_end') {
          throw new AnchorNotFoundError('root anchor supports only inside_start/inside_end')
        }
        node = currentDoc
        // Doc content spans [0, currentDoc.content.size]; inside_start prepends
        // at 0, inside_end appends at content.size (both == 0 for an empty doc).
        pos = op.at.position === 'inside_start' ? 0 : currentDoc.content.size
      } else {
        const anchor = resolveBlockPath(currentDoc, op.at.path)
        node = anchor.node
        pos = insertionPos(anchor, op.at.position)
      }
      checkExpect(node, op.expect)
      const nodes = parseContent(op.content, schema)
      resolved.push({
        kind: 'insert',
        sortPos: pos,
        from: pos,
        to: pos,
        nodes,
        insertKey: `${op.at.path.join(',')}|${op.at.position}`,
      })
    } else if (op.type === 'replace') {
      const { fromNode, fromPos, toPos } = resolveRange(currentDoc, op.range)
      checkExpect(fromNode, op.expect)
      const nodes = parseContent(op.content, schema)
      resolved.push({ kind: 'replace', sortPos: fromPos, from: fromPos, to: toPos, nodes })
    } else if (op.type === 'delete') {
      const { fromNode, fromPos, toPos } = resolveRange(currentDoc, op.range)
      checkExpect(fromNode, op.expect)
      resolved.push({ kind: 'delete', sortPos: fromPos, from: fromPos, to: toPos })
    } else {
      throw new InvalidOpsError(`unknown op type ${String((op as { type?: unknown }).type)}`)
    }
  }

  // Two inserts at the identical (path, position) anchor are rejected (§1.4 #2):
  // ordered batching at one anchor is expressed as one op's content[] instead.
  const insertKeys = new Set<string>()
  for (const r of resolved) {
    if (r.kind === 'insert' && r.insertKey !== undefined) {
      if (insertKeys.has(r.insertKey)) throw new InvalidOpsError('duplicate insert anchor')
      insertKeys.add(r.insertKey)
    }
  }

  detectOverlaps(resolved)

  // Descending start: an earlier-applied edit never shifts a not-yet-applied
  // op's positions, so no position remapping is required. When an insert point
  // and a replace/delete range share the same start (e.g. `insert after [0]` and
  // `replace [1]` both land on the boundary between the blocks), the range op is
  // applied first so the insert lands at the untouched boundary — matching
  // "apply as if on the original doc".
  resolved.sort((a, b) => {
    if (a.sortPos !== b.sortPos) return b.sortPos - a.sortPos
    return (a.kind === 'insert' ? 1 : 0) - (b.kind === 'insert' ? 1 : 0)
  })

  const tr = new Transform(currentDoc)
  for (const r of resolved) {
    if (r.kind === 'insert') {
      tr.insert(r.from, r.nodes!)
    } else if (r.kind === 'replace') {
      tr.replaceWith(r.from, r.to, r.nodes!)
    } else {
      tr.delete(r.from, r.to)
    }
  }

  const newDoc = tr.doc
  try {
    newDoc.check()
  } catch (err) {
    throw new SchemaIncompatibleError(err)
  }
  return newDoc
}

// ── size gate (§3.1 item 4a — byte-accurate vs persistence.store's cap) ─────────

/**
 * Encode the post-edit document the SAME way persistence.store caps it: hydrate a
 * scratch Y.Doc from the LIVE `preEditState` (so it carries the live clientId
 * clocks + tombstones), reconcile `newDoc` into it, and measure the encoded
 * update. A from-scratch encode would be strictly smaller (fresh clientId, no
 * accumulated history) and could pass the pre-check only to have the live commit
 * broadcast-then-fail on store — this closes that fail-closed hole.
 */
export function sizeAfterEdit(preEditState: Uint8Array, newDoc: PMNode): number {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, preEditState)
  const fragment = scratch.get(COLLAB_FIELD, Y.XmlFragment)
  scratch.transact(() => reconcileFragment(newDoc, fragment))
  return Y.encodeStateAsUpdate(scratch).length
}

// ── attachment reference validation (locked contract item 8) ────────────────────

/**
 * Collect the `attachId`s referenced by `image` / `fileAttachment` nodes in the
 * ops' inserted/replaced content. The caller verifies each belongs to this doc
 * (docAttachmentRepo) before the write, so a bot cannot embed another doc's (or a
 * non-existent) attachment. Pure: walks the raw op JSON, no DB access.
 */
export function collectAttachIds(ops: DocEditOp[]): string[] {
  const ids = new Set<string>()
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown }
    if ((n.type === 'image' || n.type === 'fileAttachment') && typeof n.attrs?.attachId === 'string' && n.attrs.attachId) {
      ids.add(n.attrs.attachId)
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) visit(child)
    }
  }
  for (const op of ops) {
    if ((op.type === 'insert' || op.type === 'replace') && Array.isArray(op.content)) {
      for (const child of op.content) visit(child)
    }
  }
  return [...ids]
}
