import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { Node as PMNode } from 'prosemirror-model'
import { prosemirrorToYDoc, prosemirrorToYXmlFragment } from 'y-prosemirror'
import { COLLAB_FIELD } from '../src/schema/index.js'
import {
  schema,
  resolveBlockPath,
  applyIncrementalOps,
  encodeBaseVersion,
  parseBaseVersion,
  stateVectorsEqual,
  sizeAfterEdit,
  collectAttachIds,
  AnchorNotFoundError,
  AnchorMismatchError,
  InvalidOpsError,
  SchemaIncompatibleError,
  type DocEditOp,
} from '../src/collab/docBodyEdit.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function para(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function docNode(content: unknown[]): PMNode {
  return PMNode.fromJSON(schema, { type: 'doc', content } as Parameters<typeof PMNode.fromJSON>[1])
}

/** Concatenate every top-level block's text (paragraphs) for easy assertions. */
function topTexts(doc: PMNode): string[] {
  const json = doc.toJSON() as { content?: Array<{ content?: Array<{ text?: string }> }> }
  return (json.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? '').join(''))
}

// ── §7.1-1.2 anchor resolution ──────────────────────────────────────────────────
describe('resolveBlockPath', () => {
  it('resolves a top-level block to its open/close positions', () => {
    const doc = docNode([para('A'), para('B')])
    const a = resolveBlockPath(doc, [0])
    // paragraph "A" nodeSize = 2 (open/close) + 1 (text) = 3.
    expect(a.start).toBe(0)
    expect(a.end).toBe(3)
    expect(a.node.type.name).toBe('paragraph')
    const b = resolveBlockPath(doc, [1])
    expect(b.start).toBe(3)
    expect(b.end).toBe(6)
  })

  it('resolves a nested block path (into a blockquote) by general descent', () => {
    const doc = docNode([{ type: 'blockquote', content: [para('inner')] }])
    const inner = resolveBlockPath(doc, [0, 0])
    // blockquote open token at 0, its content (the paragraph) starts at 1.
    expect(inner.start).toBe(1)
    expect(inner.node.type.name).toBe('paragraph')
  })

  it('throws AnchorNotFoundError for an out-of-range index', () => {
    const doc = docNode([para('A')])
    expect(() => resolveBlockPath(doc, [5])).toThrow(AnchorNotFoundError)
    expect(() => resolveBlockPath(doc, [])).toThrow(AnchorNotFoundError)
  })
})

// ── §7.1 insert / replace / delete transforms ───────────────────────────────────
describe('applyIncrementalOps — insert', () => {
  it('insert after places a sibling at the right index; neighbours unchanged', () => {
    const doc = docNode([para('A'), para('B')])
    const ops: DocEditOp[] = [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }]
    expect(topTexts(applyIncrementalOps(doc, ops, schema))).toEqual(['A', 'X', 'B'])
  })

  it('insert before places a sibling before the anchor', () => {
    const doc = docNode([para('A'), para('B')])
    const ops: DocEditOp[] = [{ type: 'insert', at: { path: [1], position: 'before' }, content: [para('X')] }]
    expect(topTexts(applyIncrementalOps(doc, ops, schema))).toEqual(['A', 'X', 'B'])
  })

  it('inside_start / inside_end append into a container (blockquote)', () => {
    const doc = docNode([{ type: 'blockquote', content: [para('mid')] }])
    const start = applyIncrementalOps(
      doc,
      [{ type: 'insert', at: { path: [0], position: 'inside_start' }, content: [para('head')] }],
      schema,
    )
    const startInner = (start.toJSON() as { content: Array<{ content: Array<{ content?: Array<{ text?: string }> }> }> })
      .content[0]!.content.map((p) => (p.content ?? []).map((c) => c.text ?? '').join(''))
    expect(startInner).toEqual(['head', 'mid'])

    const end = applyIncrementalOps(
      doc,
      [{ type: 'insert', at: { path: [0], position: 'inside_end' }, content: [para('tail')] }],
      schema,
    )
    const endInner = (end.toJSON() as { content: Array<{ content: Array<{ content?: Array<{ text?: string }> }> }> })
      .content[0]!.content.map((p) => (p.content ?? []).map((c) => c.text ?? '').join(''))
    expect(endInner).toEqual(['mid', 'tail'])
  })
})

describe('applyIncrementalOps — replace / delete', () => {
  it('replace a single block swaps exactly that block', () => {
    const doc = docNode([para('A'), para('B'), para('C')])
    const ops: DocEditOp[] = [
      { type: 'replace', range: { from: { path: [1] }, to: { path: [1] } }, content: [para('B2')] },
    ]
    expect(topTexts(applyIncrementalOps(doc, ops, schema))).toEqual(['A', 'B2', 'C'])
  })

  it('replace a multi-block inclusive range swaps exactly that range', () => {
    const doc = docNode([para('A'), para('B'), para('C'), para('D')])
    const ops: DocEditOp[] = [
      { type: 'replace', range: { from: { path: [1] }, to: { path: [2] } }, content: [para('X')] },
    ]
    expect(topTexts(applyIncrementalOps(doc, ops, schema))).toEqual(['A', 'X', 'D'])
  })

  it('delete a single block and a range removes exactly that range', () => {
    const single = applyIncrementalOps(
      docNode([para('A'), para('B'), para('C')]),
      [{ type: 'delete', range: { from: { path: [1] }, to: { path: [1] } } }],
      schema,
    )
    expect(topTexts(single)).toEqual(['A', 'C'])

    const range = applyIncrementalOps(
      docNode([para('A'), para('B'), para('C'), para('D')]),
      [{ type: 'delete', range: { from: { path: [1] }, to: { path: [2] } } }],
      schema,
    )
    expect(topTexts(range)).toEqual(['A', 'D'])
  })
})

describe('applyIncrementalOps — multi-op ordering + nested path', () => {
  it('multiple ops in one request apply as if on the original doc (descending order)', () => {
    // insert after [0], delete [2], replace [1] — all resolved against the ORIGINAL
    // doc; the descending-order application must not shift each other.
    const doc = docNode([para('A'), para('B'), para('C')])
    const ops: DocEditOp[] = [
      { type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] },
      { type: 'replace', range: { from: { path: [1] }, to: { path: [1] } }, content: [para('B2')] },
      { type: 'delete', range: { from: { path: [2] }, to: { path: [2] } } },
    ]
    // Original: A B C. after[0]->X ; [1]=B replaced by B2 ; [2]=C deleted.
    expect(topTexts(applyIncrementalOps(doc, ops, schema))).toEqual(['A', 'X', 'B2'])
  })

  it('nested-path anchor into a table cell resolves and edits the right container', () => {
    const table = {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para('cell')] }] },
      ],
    }
    const doc = docNode([table])
    // path [0,0,0,0] = table -> row -> cell -> paragraph.
    const ops: DocEditOp[] = [
      { type: 'insert', at: { path: [0, 0, 0, 0], position: 'after' }, content: [para('added')] },
    ]
    const out = applyIncrementalOps(doc, ops, schema)
    const cell = (out.toJSON() as {
      content: Array<{ content: Array<{ content: Array<{ content: Array<{ content?: Array<{ text?: string }> }> }> }> }>
    }).content[0]!.content[0]!.content[0]!.content
    expect(cell.map((p) => (p.content ?? []).map((c) => c.text ?? '').join(''))).toEqual(['cell', 'added'])
  })
})

// ── §7.13-14, 17 boundary / illegal-locator handling ────────────────────────────
describe('applyIncrementalOps — boundaries (fail-closed, before any mutation)', () => {
  it('out-of-range path → AnchorNotFoundError (422)', () => {
    const doc = docNode([para('A')])
    expect(() =>
      applyIncrementalOps(doc, [{ type: 'insert', at: { path: [9], position: 'after' }, content: [para('X')] }], schema),
    ).toThrow(AnchorNotFoundError)
  })

  it('expect.type mismatch → AnchorMismatchError (422)', () => {
    const doc = docNode([para('A')])
    expect(() =>
      applyIncrementalOps(
        doc,
        [{ type: 'replace', range: { from: { path: [0] }, to: { path: [0] } }, expect: { type: 'heading' }, content: [para('X')] }],
        schema,
      ),
    ).toThrow(AnchorMismatchError)
  })

  it('overlapping ranges → InvalidOpsError (422)', () => {
    const doc = docNode([para('A'), para('B'), para('C')])
    const ops: DocEditOp[] = [
      { type: 'delete', range: { from: { path: [0] }, to: { path: [1] } } },
      { type: 'replace', range: { from: { path: [1] }, to: { path: [2] } }, content: [para('X')] },
    ]
    expect(() => applyIncrementalOps(doc, ops, schema)).toThrow(InvalidOpsError)
  })

  it('range from > to (cross-parent guarded too) → InvalidOpsError (422)', () => {
    const doc = docNode([para('A'), para('B')])
    expect(() =>
      applyIncrementalOps(doc, [{ type: 'delete', range: { from: { path: [1] }, to: { path: [0] } } }], schema),
    ).toThrow(InvalidOpsError)
    // cross-parent range (different parents) is rejected as well.
    const nested = docNode([{ type: 'blockquote', content: [para('x')] }, para('y')])
    expect(() =>
      applyIncrementalOps(nested, [{ type: 'delete', range: { from: { path: [0, 0] }, to: { path: [1] } } }], schema),
    ).toThrow(InvalidOpsError)
  })

  it('two inserts at the same (path, position) anchor → InvalidOpsError (422)', () => {
    const doc = docNode([para('A')])
    const ops: DocEditOp[] = [
      { type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] },
      { type: 'insert', at: { path: [0], position: 'after' }, content: [para('Y')] },
    ]
    expect(() => applyIncrementalOps(doc, ops, schema)).toThrow(InvalidOpsError)
  })

  it('content with an unknown node type → SchemaIncompatibleError (422)', () => {
    const doc = docNode([para('A')])
    expect(() =>
      applyIncrementalOps(
        doc,
        [{ type: 'insert', at: { path: [0], position: 'after' }, content: [{ type: 'frobnicate' }] }],
        schema,
      ),
    ).toThrow(SchemaIncompatibleError)
  })

  it('empty op batch / empty content → InvalidOpsError (422)', () => {
    const doc = docNode([para('A')])
    expect(() => applyIncrementalOps(doc, [], schema)).toThrow(InvalidOpsError)
    expect(() =>
      applyIncrementalOps(doc, [{ type: 'insert', at: { path: [0], position: 'after' }, content: [] }], schema),
    ).toThrow(InvalidOpsError)
  })
})

// ── §4 base-version codec + equality ────────────────────────────────────────────
describe('base-version codec + state-vector equality', () => {
  it('encode/parse round-trips a Y state vector', () => {
    const d = new Y.Doc()
    const frag = d.get(COLLAB_FIELD, Y.XmlFragment)
    d.transact(() => prosemirrorToYXmlFragment(docNode([para('A')]), frag))
    const sv = Y.encodeStateVector(d)
    expect(parseBaseVersion(encodeBaseVersion(sv))).toEqual(sv)
  })

  it('stateVectorsEqual is byte-exact', () => {
    expect(stateVectorsEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(stateVectorsEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(stateVectorsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

// ── §7.16 size gate uses the live-hydrated measure (not a from-scratch encode) ──
describe('sizeAfterEdit — live-hydrated encode (item 4a)', () => {
  it('measures MORE than a from-scratch encode of the same newDoc (carries live history)', () => {
    // Build a live state with accumulated history: insert many blocks then delete
    // most of them, so the encoded update carries tombstones a fresh encode lacks.
    const live = new Y.Doc()
    const frag = live.get(COLLAB_FIELD, Y.XmlFragment)
    const big = Array.from({ length: 40 }, (_, i) => para(`line ${i}`))
    live.transact(() => prosemirrorToYXmlFragment(docNode(big), frag))
    // Now reconcile down to a single paragraph (records 39 deletions as tombstones).
    live.transact(() => prosemirrorToYXmlFragment(docNode([para('only')]), frag))
    const preEditState = Y.encodeStateAsUpdate(live)

    const newDoc = docNode([para('only'), para('added')])

    const hydrated = sizeAfterEdit(preEditState, newDoc)
    // A from-scratch encode of the SAME newDoc carries no accumulated history.
    const fresh = Y.encodeStateAsUpdate(prosemirrorToYDoc(newDoc, COLLAB_FIELD)).length
    expect(hydrated).toBeGreaterThan(fresh)
  })
})

// ── locked contract item 8: attachment reference collection ─────────────────────
describe('collectAttachIds', () => {
  it('collects image + fileAttachment attachIds from inserted/replaced content (nested too)', () => {
    const ops: DocEditOp[] = [
      { type: 'insert', at: { path: [0], position: 'after' }, content: [{ type: 'image', attrs: { attachId: 'a1' } }] },
      {
        type: 'replace',
        range: { from: { path: [1] }, to: { path: [1] } },
        content: [
          { type: 'blockquote', content: [{ type: 'fileAttachment', attrs: { attachId: 'a2' } }] },
          { type: 'image', attrs: { attachId: 'a1' } }, // dup collapses
        ],
      },
      { type: 'delete', range: { from: { path: [2] }, to: { path: [2] } } },
    ]
    expect(collectAttachIds(ops).sort()).toEqual(['a1', 'a2'])
  })

  it('returns [] when no attachment nodes are referenced', () => {
    expect(collectAttachIds([{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('x')] }])).toEqual([])
  })
})
