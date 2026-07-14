import { describe, it, expect } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { prosemirrorToYDoc } from 'y-prosemirror'
import * as Y from 'yjs'
import {
  COLLAB_FIELD,
  sanitizeBlockAttrValues,
} from '../src/schema/index.js'
import { yDocStateToProsemirrorJSON } from '../src/agent/conversion.js'
import { schema, applyIncrementalOps, type DocEditOp } from '../src/collab/docBodyEdit.js'

// Security invariant (SCHEMA-SPEC §17): a hostile lineHeight / spaceBefore /
// spaceAfter value must NEVER reach the Y.Doc through the AUTHORITATIVE client
// write path. That path is JSON, not HTML: PATCH /:docId/content ->
// applyIncrementalOps -> parseContent -> PMNode.fromJSON(schema, json). fromJSON
// reads attr VALUES verbatim and .check() only validates attr SHAPE — neither
// runs the parseDOM getBlockAttrs sanitizer. Without the JSON-write sanitize
// pass a caller can smuggle a multi-declaration value straight into storage,
// where it round-trips out of GET /:docId/content unchanged.
describe('JSON write-path block-attr value sanitize (§17 security invariant)', () => {
  function para(text: string, attrs: Record<string, unknown>) {
    return { type: 'paragraph', attrs, content: [{ type: 'text', text }] }
  }

  function docNode(content: unknown[]): PMNode {
    return PMNode.fromJSON(schema, { type: 'doc', content } as Parameters<typeof PMNode.fromJSON>[1])
  }

  // Read the stored attrs of the first top-level block back out of the Y.Doc,
  // exactly as GET /:docId/content would (prosemirror -> Y.Doc -> prosemirror).
  function storedFirstBlockAttrs(doc: PMNode): Record<string, unknown> {
    const ydoc = prosemirrorToYDoc(doc, COLLAB_FIELD)
    const state = Y.encodeStateAsUpdate(ydoc)
    const back = yDocStateToProsemirrorJSON(state) as {
      content?: Array<{ attrs?: Record<string, unknown> }>
    }
    return back.content?.[0]?.attrs ?? {}
  }

  const HOSTILE = {
    lineHeight: '1.5; position: fixed; inset: 0',
    spaceBefore: '8px); background: url(evil',
    spaceAfter: 'calc(100% + 999px)',
  }

  it('sanitizeBlockAttrValues coerces hostile values to null in place (nested too)', () => {
    const json = {
      type: 'doc',
      content: [
        para('a', { ...HOSTILE }),
        {
          type: 'blockquote',
          content: [para('nested', { lineHeight: '2); evil', spaceAfter: '4em' })],
        },
      ],
    }
    sanitizeBlockAttrValues(json)
    expect(json.content[0].attrs).toEqual({ lineHeight: null, spaceBefore: null, spaceAfter: null })
    // Nested paragraph inside the blockquote is reached by the recursion; the
    // legal `4em` survives, the hostile line-height is dropped.
    const nested = (json.content[1] as { content: Array<{ attrs: Record<string, unknown> }> }).content[0]
    expect(nested.attrs).toEqual({ lineHeight: null, spaceAfter: '4em' })
  })

  it('keeps legal values untouched', () => {
    const json = { type: 'doc', content: [para('ok', { lineHeight: '1.5', spaceBefore: '8px', spaceAfter: '12px' })] }
    sanitizeBlockAttrValues(json)
    expect(json.content[0].attrs).toEqual({ lineHeight: '1.5', spaceBefore: '8px', spaceAfter: '12px' })
  })

  it('sanitizeBlockAttrValues clamps/nulls the v18 indent level in place', () => {
    const json = {
      type: 'doc',
      content: [
        para('over', { indent: 99 }),
        para('hostile', { indent: 'evil' }),
        para('legal', { indent: 3 }),
      ],
    }
    sanitizeBlockAttrValues(json)
    expect(json.content[0].attrs).toEqual({ indent: 8 })
    expect(json.content[1].attrs).toEqual({ indent: null })
    expect(json.content[2].attrs).toEqual({ indent: 3 })
  })

  it('insert op: hostile values are dropped before entering the Y.Doc', () => {
    const doc = docNode([para('seed', {})])
    const ops: DocEditOp[] = [
      { type: 'insert', at: { path: [0], position: 'after' }, content: [para('evil', { ...HOSTILE })] },
    ]
    const newDoc = applyIncrementalOps(doc, ops, schema)
    // The block actually stored into the Y.Doc carries sanitized (null) values,
    // not the hostile strings — the null defaults are stripped from storage.
    const inserted = newDoc.child(1)
    expect(inserted.attrs.lineHeight).toBeNull()
    expect(inserted.attrs.spaceBefore).toBeNull()
    expect(inserted.attrs.spaceAfter).toBeNull()

    const storedBack = yDocStateToProsemirrorJSON(
      Y.encodeStateAsUpdate(prosemirrorToYDoc(newDoc, COLLAB_FIELD)),
    ) as { content?: Array<{ attrs?: Record<string, unknown> }> }
    // GET returns the inserted paragraph with no lineHeight/spacing attrs at all.
    expect(storedBack.content?.[1]?.attrs ?? {}).not.toHaveProperty('lineHeight')
    expect(JSON.stringify(storedBack)).not.toContain('position: fixed')
  })

  it('replace op: a legal value survives, a hostile sibling value is dropped', () => {
    const doc = docNode([para('a', {}), para('b', {})])
    const ops: DocEditOp[] = [
      {
        type: 'replace',
        range: { from: { path: [0] }, to: { path: [0] } },
        content: [para('legal', { lineHeight: '1.5', spaceAfter: 'javascript:1' })],
      },
    ]
    const newDoc = applyIncrementalOps(doc, ops, schema)
    const replaced = newDoc.child(0)
    expect(replaced.attrs.lineHeight).toBe('1.5')
    expect(replaced.attrs.spaceAfter).toBeNull()
    // And it round-trips through the Y.Doc storage the same way.
    expect(storedFirstBlockAttrs(newDoc)).toMatchObject({ lineHeight: '1.5' })
    expect(storedFirstBlockAttrs(newDoc)).not.toHaveProperty('spaceAfter')
  })

  // textAlign is the OLDEST of the four block attrs (v5) but shares the SAME
  // serialized `style` string as lineHeight/spaceBefore/spaceAfter. It was
  // missing from the JSON-write sanitizer, so a hostile textAlign could still
  // smuggle a multi-declaration value into the authoritative store through
  // PMNode.fromJSON. It must be sanitized on this path like its style siblings.
  it('sanitizeBlockAttrValues coerces a hostile textAlign to null, keeps legal ones', () => {
    const json = {
      type: 'doc',
      content: [
        para('evil', { textAlign: 'left; position: fixed; inset: 0' }),
        para('ok', { textAlign: 'center' }),
        para('bogus', { textAlign: 'middle' }),
      ],
    }
    sanitizeBlockAttrValues(json)
    expect(json.content[0].attrs).toEqual({ textAlign: null })
    expect(json.content[1].attrs).toEqual({ textAlign: 'center' })
    expect(json.content[2].attrs).toEqual({ textAlign: null })
  })

  it('insert op: a hostile textAlign never reaches the Y.Doc', () => {
    const doc = docNode([para('seed', {})])
    const ops: DocEditOp[] = [
      {
        type: 'insert',
        at: { path: [0], position: 'after' },
        content: [para('evil', { textAlign: 'right; background: url(evil)' })],
      },
    ]
    const newDoc = applyIncrementalOps(doc, ops, schema)
    // The block stored into the Y.Doc carries a sanitized (null) textAlign, not
    // the hostile string — the null default is stripped from storage.
    expect(newDoc.child(1).attrs.textAlign).toBeNull()

    const storedBack = yDocStateToProsemirrorJSON(
      Y.encodeStateAsUpdate(prosemirrorToYDoc(newDoc, COLLAB_FIELD)),
    ) as { content?: Array<{ attrs?: Record<string, unknown> }> }
    expect(storedBack.content?.[1]?.attrs ?? {}).not.toHaveProperty('textAlign')
    expect(JSON.stringify(storedBack)).not.toContain('position: fixed')
    expect(JSON.stringify(storedBack)).not.toContain('background: url')
  })
})
