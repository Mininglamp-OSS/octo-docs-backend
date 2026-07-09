/**
 * Server-side anchor resolution from `anchorText` (feature #70 — bot root
 * comments without a live editor selection).
 *
 * A browser client produces a root comment's `anchorStart` / `anchorEnd` from a
 * live ProseMirror selection: it encodes the two selection endpoints as Yjs
 * RelativePosition bytes. A bot has no live selection, so it supplies the
 * SELECTED TEXT (`anchorText`) plus optional disambiguation (`blockPath` /
 * `occurrence`) and the server reproduces the same encoding:
 *
 *   1. Rebuild the live document as a ProseMirror doc + a Y-type↔PM-node mapping
 *      via y-prosemirror's `initProseMirrorDoc` (no DOM, runs in Node).
 *   2. Locate `anchorText` in the doc's text content -> absolute PM positions.
 *   3. Encode those absolute positions to Yjs RelativePositions with
 *      `absolutePositionToRelativePosition`, then to the SAME base64-able bytes a
 *      live client would have produced (the inverse of `decodeAnchor`).
 *
 * The ambiguity contract is fail-loud (design item 3): more than one match with
 * no disambiguation throws `AmbiguousAnchorError` (422 `ambiguous_anchor`) rather
 * than silently picking the first; no match throws `AnchorTextNotFoundError`
 * (422 `anchor_text_not_found`). `blockPath` narrows to a single block and
 * `occurrence` (1-based) picks the Nth match among the remaining candidates.
 */
import * as Y from 'yjs'
import type { Document } from '@hocuspocus/server'
import { Node as PMNode } from 'prosemirror-model'
import { initProseMirrorDoc, absolutePositionToRelativePosition } from 'y-prosemirror'
import { getCollabServer } from './server.js'
import { schema as sharedSchema } from './docBodyEdit.js'
import { COLLAB_FIELD } from '../schema/index.js'
import type { BlockPath } from './docBodyEdit.js'

/** More than one `anchorText` match survived disambiguation (422). */
export class AmbiguousAnchorError extends Error {
  readonly code = 'ambiguous_anchor'
  /** All candidate block paths, so the caller/bot can pick one to disambiguate. */
  readonly matches: BlockPath[]
  constructor(matches: BlockPath[]) {
    super('ambiguous_anchor')
    this.name = 'AmbiguousAnchorError'
    this.matches = matches
  }
}

/** `anchorText` was not found (or the requested `occurrence` is out of range) (422). */
export class AnchorTextNotFoundError extends Error {
  readonly code = 'anchor_text_not_found'
  constructor(message = 'anchor_text_not_found') {
    super(message)
    this.name = 'AnchorTextNotFoundError'
  }
}

/** A single located occurrence: the block that contains it + its absolute range. */
export interface AnchorMatch {
  /** Child-index path from the doc root down to the text block (see resolveBlockPath). */
  blockPath: BlockPath
  /** Absolute ProseMirror position of the match start (before the first char). */
  from: number
  /** Absolute ProseMirror position of the match end (after the last char). */
  to: number
}

export interface ResolveAnchorOptions {
  anchorText: string
  /** Restrict matches to the text block at exactly this path. */
  blockPath?: BlockPath
  /** 1-based index selecting the Nth remaining candidate. */
  occurrence?: number
}

export interface ResolvedAnchor {
  /** Encoded Yjs RelativePosition bytes (raw, ready to base64/store as BLOB). */
  anchorStart: Buffer
  anchorEnd: Buffer
  /** The block the match was found in — echoed back so a bot can learn the path. */
  blockPath: BlockPath
  from: number
  to: number
}

function samePath(a: BlockPath, b: BlockPath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Find every occurrence of `needle` in the document's text content, returning
 * each match's containing block path and its absolute PM position range. Matches
 * are collected in document order; occurrences are non-overlapping.
 *
 * Only text-node characters contribute to the searched string (inline atoms such
 * as `mention` / `image` are skipped), so `from`/`to` are computed from a
 * per-character absolute-position table (`posOf`) built while walking the block's
 * inline children. A raw `indexOf` hit can be spurious, though: two text runs
 * separated by an inline atom sit adjacent in the search string but are NOT
 * contiguous in the document, so a needle could appear to match across the atom.
 * Such a hit is rejected — a real occurrence's characters must be at consecutive
 * absolute positions (`posOf[idx + k] === posOf[idx] + k`) — so the returned
 * range never silently widens over an atom that was never part of the text.
 */
export function findAnchorMatches(doc: PMNode, needle: string): AnchorMatch[] {
  if (needle.length === 0) return []
  const matches: AnchorMatch[] = []

  const collectInBlock = (block: PMNode, path: BlockPath, contentStart: number): void => {
    let text = ''
    // posOf[i] = absolute PM position immediately before the i-th collected char.
    const posOf: number[] = []
    let p = contentStart
    block.forEach((inline) => {
      if (inline.isText && inline.text) {
        const t = inline.text
        for (let i = 0; i < t.length; i++) {
          text += t[i]
          posOf.push(p + i)
        }
      }
      p += inline.nodeSize
    })
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      const from = posOf[idx]!
      // Reject a hit whose characters are not at consecutive absolute positions:
      // an inline atom fell inside the span, so this run only appeared adjacent
      // in the text-only search string and never existed continuously in the doc.
      let contiguous = true
      for (let k = 1; k < needle.length; k++) {
        if (posOf[idx + k] !== from + k) {
          contiguous = false
          break
        }
      }
      if (contiguous) {
        // `to` is one past the last char; for a contiguous run this equals
        // posOf[idx + needle.length - 1] + 1.
        matches.push({ blockPath: path, from, to: from + needle.length })
        idx = text.indexOf(needle, idx + needle.length)
      } else {
        // Keep scanning: a real (contiguous) occurrence may still start later,
        // even inside this rejected span, so advance by one rather than skipping
        // the whole needle width.
        idx = text.indexOf(needle, idx + 1)
      }
    }
  }

  const walk = (node: PMNode, path: BlockPath, contentStart: number): void => {
    if (node.isTextblock) {
      collectInBlock(node, path, contentStart)
      return
    }
    let childStart = contentStart
    node.forEach((child, _offset, index) => {
      // A non-leaf child's own content begins one past its open token.
      walk(child, path.concat(index), childStart + 1)
      childStart += child.nodeSize
    })
  }

  // The doc's top node has no surrounding tokens: its content starts at 0.
  walk(doc, [], 0)
  return matches
}

/**
 * Apply the disambiguation contract to a set of matches (design item 3):
 *   - `blockPath` filters to matches inside that exact block.
 *   - `occurrence` (1-based) then selects the Nth remaining candidate.
 *   - 0 candidates  -> AnchorTextNotFoundError
 *   - >1 candidates -> AmbiguousAnchorError (never silently take the first)
 */
export function selectAnchorMatch(
  matches: AnchorMatch[],
  blockPath?: BlockPath,
  occurrence?: number,
): AnchorMatch {
  let candidates = matches
  if (blockPath !== undefined) {
    candidates = candidates.filter((m) => samePath(m.blockPath, blockPath))
  }
  if (occurrence !== undefined) {
    const picked = candidates[occurrence - 1]
    if (!picked) {
      throw new AnchorTextNotFoundError(`occurrence ${occurrence} out of range (${candidates.length} match(es))`)
    }
    return picked
  }
  if (candidates.length === 0) throw new AnchorTextNotFoundError()
  if (candidates.length > 1) throw new AmbiguousAnchorError(candidates.map((m) => m.blockPath))
  return candidates[0]!
}

/**
 * Resolve `anchorText` against a live Y.Doc fragment to encoded anchor bytes.
 * Pure w.r.t. the platform (no live connection) so it is unit-testable with an
 * in-memory Y.Doc; the live orchestrator below supplies the real fragment.
 */
export function resolveAnchorInFragment(
  fragment: Y.XmlFragment,
  opts: ResolveAnchorOptions,
): ResolvedAnchor {
  const { doc, mapping } = initProseMirrorDoc(fragment, sharedSchema)
  const matches = findAnchorMatches(doc, opts.anchorText)
  const picked = selectAnchorMatch(matches, opts.blockPath, opts.occurrence)
  const relStart = absolutePositionToRelativePosition(picked.from, fragment, mapping)
  const relEnd = absolutePositionToRelativePosition(picked.to, fragment, mapping)
  return {
    anchorStart: Buffer.from(Y.encodeRelativePosition(relStart)),
    anchorEnd: Buffer.from(Y.encodeRelativePosition(relEnd)),
    blockPath: picked.blockPath,
    from: picked.from,
    to: picked.to,
  }
}

/**
 * Live-document orchestrator: open a read-only direct connection to the same
 * in-memory Y.Doc the clients edit, resolve `anchorText` inside a transact for a
 * consistent view, and disconnect without mutating (mirrors readLiveForEdit).
 */
export async function resolveAnchorFromLiveDoc(
  documentName: string,
  opts: ResolveAnchorOptions,
): Promise<ResolvedAnchor> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: 'system' } })
  let result!: ResolvedAnchor
  try {
    await connection.transact((doc: Document) => {
      const fragment = doc.getXmlFragment(COLLAB_FIELD)
      result = resolveAnchorInFragment(fragment, opts)
    })
  } finally {
    await connection.disconnect()
  }
  return result
}
