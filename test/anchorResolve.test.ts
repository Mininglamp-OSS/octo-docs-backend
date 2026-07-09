import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Node as PMNode } from 'prosemirror-model'
import {
  prosemirrorToYDoc,
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from 'y-prosemirror'
import { COLLAB_FIELD } from '../src/schema/index.js'
import { schema } from '../src/collab/docBodyEdit.js'
import {
  findAnchorMatches,
  selectAnchorMatch,
  resolveAnchorInFragment,
  AmbiguousAnchorError,
  AnchorTextNotFoundError,
} from '../src/collab/anchorResolve.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function para(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

/** Build a live Y.Doc fragment from ProseMirror block JSON (the shape a client edits). */
function fragmentOf(content: unknown[]): { ydoc: Y.Doc; fragment: Y.XmlFragment } {
  const pmDoc = PMNode.fromJSON(schema, { type: 'doc', content } as Parameters<typeof PMNode.fromJSON>[1])
  const ydoc = prosemirrorToYDoc(pmDoc, COLLAB_FIELD)
  return { ydoc, fragment: ydoc.getXmlFragment(COLLAB_FIELD) }
}

/**
 * Assert the encoded anchors bound exactly `expectedText` in the live doc: the
 * resolved absolute range must slice out that text, and the encoded
 * RelativePosition bytes must round-trip back to the same absolute positions
 * (proving the encoding, not just the search, is correct).
 */
function expectAnchorsCover(
  ydoc: Y.Doc,
  fragment: Y.XmlFragment,
  resolved: { anchorStart: Buffer; anchorEnd: Buffer; from: number; to: number },
  expectedText: string,
) {
  const { doc, mapping } = initProseMirrorDoc(fragment, schema)
  expect(doc.textBetween(resolved.from, resolved.to)).toBe(expectedText)
  const relStart = Y.decodeRelativePosition(new Uint8Array(resolved.anchorStart))
  const relEnd = Y.decodeRelativePosition(new Uint8Array(resolved.anchorEnd))
  expect(relativePositionToAbsolutePosition(ydoc, fragment, relStart, mapping)).toBe(resolved.from)
  expect(relativePositionToAbsolutePosition(ydoc, fragment, relEnd, mapping)).toBe(resolved.to)
}

// ── (1) unique match ────────────────────────────────────────────────────────────
describe('resolveAnchorInFragment — unique match', () => {
  it('resolves a single occurrence to anchors that bound the text', () => {
    const { ydoc, fragment } = fragmentOf([para('the quick brown fox'), para('jumps over')])
    const resolved = resolveAnchorInFragment(fragment, { anchorText: 'brown fox' })
    expect(resolved.blockPath).toEqual([0])
    expectAnchorsCover(ydoc, fragment, resolved, 'brown fox')
  })

  it('resolves a match inside a nested block (blockquote > paragraph)', () => {
    const { ydoc, fragment } = fragmentOf([
      { type: 'blockquote', content: [para('nested quote text')] },
    ])
    const resolved = resolveAnchorInFragment(fragment, { anchorText: 'quote' })
    expect(resolved.blockPath).toEqual([0, 0])
    expectAnchorsCover(ydoc, fragment, resolved, 'quote')
  })
})

// ── (2) multiple matches -> fail-loud 422 ────────────────────────────────────────
describe('resolveAnchorInFragment — ambiguous match', () => {
  it('throws AmbiguousAnchorError when the text occurs in more than one block', () => {
    const { fragment } = fragmentOf([para('repeat me'), para('and repeat me again')])
    let thrown: unknown
    try {
      resolveAnchorInFragment(fragment, { anchorText: 'repeat me' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AmbiguousAnchorError)
    expect((thrown as AmbiguousAnchorError).code).toBe('ambiguous_anchor')
    // Both candidate block paths are reported so the caller can disambiguate.
    expect((thrown as AmbiguousAnchorError).matches).toEqual([[0], [1]])
  })

  it('throws AmbiguousAnchorError when the text occurs twice in the SAME block', () => {
    const { fragment } = fragmentOf([para('go go go')])
    expect(() => resolveAnchorInFragment(fragment, { anchorText: 'go' })).toThrow(AmbiguousAnchorError)
  })
})

// ── (3) in-block disambiguation via blockPath + occurrence ───────────────────────
describe('resolveAnchorInFragment — disambiguation', () => {
  it('narrows to one block with blockPath', () => {
    const { ydoc, fragment } = fragmentOf([para('alpha target'), para('beta target')])
    const resolved = resolveAnchorInFragment(fragment, { anchorText: 'target', blockPath: [1] })
    expect(resolved.blockPath).toEqual([1])
    expectAnchorsCover(ydoc, fragment, resolved, 'target')
  })

  it('picks the Nth occurrence within a block using blockPath + occurrence', () => {
    // "x" appears twice in block [0] and once in block [1]; blockPath+occurrence
    // must select the SECOND "x" of block [0].
    const { ydoc, fragment } = fragmentOf([para('x and x'), para('x')])
    const resolved = resolveAnchorInFragment(fragment, {
      anchorText: 'x',
      blockPath: [0],
      occurrence: 2,
    })
    expect(resolved.blockPath).toEqual([0])
    expectAnchorsCover(ydoc, fragment, resolved, 'x')
    // The second "x" in "x and x" starts at PM position 7 (1 + len("x and ")).
    expect(resolved.from).toBe(7)
  })

  it('occurrence alone selects the Nth global match', () => {
    const { ydoc, fragment } = fragmentOf([para('dup'), para('dup')])
    const resolved = resolveAnchorInFragment(fragment, { anchorText: 'dup', occurrence: 2 })
    expect(resolved.blockPath).toEqual([1])
    expectAnchorsCover(ydoc, fragment, resolved, 'dup')
  })

  it('throws AnchorTextNotFoundError when occurrence is out of range', () => {
    const { fragment } = fragmentOf([para('only one here')])
    expect(() => resolveAnchorInFragment(fragment, { anchorText: 'one', occurrence: 2 })).toThrow(
      AnchorTextNotFoundError,
    )
  })
})

// ── (4) no match -> clear error ──────────────────────────────────────────────────
describe('resolveAnchorInFragment — no match', () => {
  it('throws AnchorTextNotFoundError when the text is absent', () => {
    const { fragment } = fragmentOf([para('nothing to see')])
    let thrown: unknown
    try {
      resolveAnchorInFragment(fragment, { anchorText: 'absent phrase' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AnchorTextNotFoundError)
    expect((thrown as AnchorTextNotFoundError).code).toBe('anchor_text_not_found')
  })

  it('throws AnchorTextNotFoundError when blockPath points at a block without the text', () => {
    const { fragment } = fragmentOf([para('has target'), para('empty')])
    expect(() =>
      resolveAnchorInFragment(fragment, { anchorText: 'target', blockPath: [1] }),
    ).toThrow(AnchorTextNotFoundError)
  })
})

// ── unit coverage for the pure search / select building blocks ───────────────────
describe('findAnchorMatches', () => {
  it('returns non-overlapping occurrences in document order with block paths', () => {
    const { fragment } = fragmentOf([para('aa aa'), para('aa')])
    const { doc } = initProseMirrorDoc(fragment, schema)
    const matches = findAnchorMatches(doc, 'aa')
    expect(matches.map((m) => m.blockPath)).toEqual([[0], [0], [1]])
  })

  it('returns [] for an empty needle', () => {
    const { fragment } = fragmentOf([para('anything')])
    const { doc } = initProseMirrorDoc(fragment, schema)
    expect(findAnchorMatches(doc, '')).toEqual([])
  })
})

describe('selectAnchorMatch', () => {
  const matches = [
    { blockPath: [0], from: 1, to: 2 },
    { blockPath: [0], from: 5, to: 6 },
    { blockPath: [1], from: 9, to: 10 },
  ]
  it('returns the sole match when unambiguous', () => {
    expect(selectAnchorMatch([matches[0]!])).toBe(matches[0])
  })
  it('throws AmbiguousAnchorError on multiple candidates', () => {
    expect(() => selectAnchorMatch(matches)).toThrow(AmbiguousAnchorError)
  })
  it('throws AnchorTextNotFoundError on zero candidates', () => {
    expect(() => selectAnchorMatch([])).toThrow(AnchorTextNotFoundError)
  })
  it('filters by blockPath then requires uniqueness', () => {
    expect(() => selectAnchorMatch(matches, [0])).toThrow(AmbiguousAnchorError)
    expect(selectAnchorMatch(matches, [1])).toBe(matches[2])
  })
})
