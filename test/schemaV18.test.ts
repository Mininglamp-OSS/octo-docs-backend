import { describe, it, expect } from 'vitest'
import { buildSchema } from '../src/schema/index.js'
import {
  prosemirrorJSONToYDocState,
  yDocStateToProsemirrorJSON,
} from '../src/agent/conversion.js'

// v18 (SCHEMA-SPEC §16): heading/paragraph gain an integer `indent` LEVEL attr
// (default null = no indent; a set indent is 1..8). It rides the SAME inline
// `style` string as v5 textAlign / v17 block-spacing, appended as `margin-left:
// level*2em` after the v17 declarations, and round-trips the level as a
// `data-indent` attribute. Byte-aligned with the front-end ParagraphIndent
// extension. Sanitized (clamped to [1,8] or null) at parse + render + JSON write.
describe('Schema v18 indent attr (heading / paragraph)', () => {
  const schema = buildSchema()

  function toDOM(nodeName: 'paragraph' | 'heading', attrs: Record<string, unknown>): Record<string, string> {
    const node = schema.nodes[nodeName].create(attrs)
    const out = schema.nodes[nodeName].spec.toDOM!(node) as [string, Record<string, string>, number]
    return out[1]
  }

  function parseAttrs(
    nodeName: 'paragraph' | 'heading',
    style: Record<string, string>,
    dataIndent: string | null,
  ): Record<string, unknown> {
    const rule = schema.nodes[nodeName].spec.parseDOM!.find((r) =>
      nodeName === 'paragraph' ? r.tag === 'p' : r.tag === 'h1',
    )!
    const el = {
      style,
      getAttribute: (name: string) => (name === 'data-indent' ? dataIndent : null),
    }
    return rule.getAttrs!(el as never) as Record<string, unknown>
  }

  it('registers the indent attr (default null) on paragraph and heading', () => {
    for (const name of ['paragraph', 'heading'] as const) {
      const attrs = schema.nodes[name].spec.attrs!
      expect(attrs.indent?.default).toBe(null)
    }
  })

  it('serializes a set indent as margin-left + data-indent (after the v17 decls)', () => {
    const out = toDOM('paragraph', { textAlign: 'right', indent: 2 })
    expect(out.style).toBe('text-align: right; margin-left: 4em')
    expect(out['data-indent']).toBe('2')
  })

  it('emits margin-left alone when only indent is set', () => {
    const out = toDOM('paragraph', { indent: 3 })
    expect(out.style).toBe('margin-left: 6em')
    expect(out['data-indent']).toBe('3')
  })

  it('omits indent entirely at the null default (backward-compatible)', () => {
    const out = toDOM('paragraph', {})
    expect(out.style).toBeUndefined()
    expect(out['data-indent']).toBeUndefined()
  })

  it('clamps an over-max indent to 8 and coerces a hostile value to null', () => {
    expect(toDOM('paragraph', { indent: 99 })['data-indent']).toBe('8')
    expect(toDOM('paragraph', { indent: 0 })['data-indent']).toBeUndefined()
    expect(toDOM('paragraph', { indent: 'evil' })['data-indent']).toBeUndefined()
    expect(toDOM('paragraph', { indent: -3 })['data-indent']).toBeUndefined()
  })

  it('parses the level back off data-indent (authoritative over the margin em)', () => {
    expect(parseAttrs('paragraph', { marginLeft: '4em' }, '2')).toMatchObject({ indent: 2 })
    // No data-indent -> null (a bare margin-left is not treated as an indent level).
    expect(parseAttrs('paragraph', { marginLeft: '4em' }, null)).toMatchObject({ indent: null })
  })

  it('round-trips a set indent through the Y.Doc <-> ProseMirror conversion', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { textAlign: 'center', indent: 2, level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          attrs: { indent: 1 },
          content: [{ type: 'text', text: 'body' }],
        },
      ],
    }
    const expected = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { textAlign: 'center', indent: 2, level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          attrs: { indent: 1 },
          content: [{ type: 'text', text: 'body' }],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(expected)
  })

  it('leaves a plain paragraph attr-free after round-trip (null indent stripped)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
  })
})
