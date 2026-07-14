import { describe, it, expect } from 'vitest'
import { buildSchema } from '../src/schema/index.js'
import {
  prosemirrorJSONToYDocState,
  yDocStateToProsemirrorJSON,
} from '../src/agent/conversion.js'

// v17 (SCHEMA-SPEC §17): heading/paragraph gain lineHeight + spaceBefore +
// spaceAfter global attrs. They ride the SAME inline `style` string as the v5
// textAlign attr; `setBlockAttrs` is the canonical serialization the frontend
// LineHeight extension byte-aligns to. Every value is whitelist-sanitized at
// BOTH parse and render.
describe('Schema v17 block-spacing attrs (lineHeight / spaceBefore / spaceAfter)', () => {
  const schema = buildSchema()

  function toDOMStyle(nodeName: 'paragraph' | 'heading', attrs: Record<string, unknown>): string | undefined {
    const node = schema.nodes[nodeName].create(attrs)
    const out = schema.nodes[nodeName].spec.toDOM!(node) as [string, Record<string, string>, number]
    return out[1].style
  }

  function parseStyle(nodeName: 'paragraph' | 'heading', style: Record<string, string>): Record<string, unknown> {
    const rule = schema.nodes[nodeName].spec.parseDOM!.find((r) =>
      nodeName === 'paragraph' ? r.tag === 'p' : r.tag === 'h1',
    )!
    const el = {
      style,
      getAttribute: () => null,
    }
    return rule.getAttrs!(el as never) as Record<string, unknown>
  }

  it('registers the three attrs (default null) on paragraph and heading', () => {
    for (const name of ['paragraph', 'heading'] as const) {
      const attrs = schema.nodes[name].spec.attrs!
      expect(attrs.lineHeight?.default).toBe(null)
      expect(attrs.spaceBefore?.default).toBe(null)
      expect(attrs.spaceAfter?.default).toBe(null)
    }
  })

  it('serializes attrs into ONE style string in the canonical order', () => {
    expect(
      toDOMStyle('paragraph', {
        textAlign: 'right',
        lineHeight: '2',
        spaceBefore: '8px',
        spaceAfter: '12px',
      }),
    ).toBe('text-align: right; line-height: 2; margin-top: 8px; margin-bottom: 12px')
  })

  it('emits only the set declarations (line-height alone)', () => {
    expect(toDOMStyle('paragraph', { lineHeight: '1.5' })).toBe('line-height: 1.5')
  })

  it('omits the style attr entirely when every block attr is the null default', () => {
    expect(toDOMStyle('paragraph', {})).toBeUndefined()
  })

  it('keeps textAlign-only output byte-identical to the v5 behavior', () => {
    expect(toDOMStyle('paragraph', { textAlign: 'center' })).toBe('text-align: center')
  })

  it('parses the block attrs back off an element style', () => {
    expect(
      parseStyle('paragraph', {
        lineHeight: '1.5',
        marginTop: '8px',
        marginBottom: '12px',
      }),
    ).toMatchObject({ lineHeight: '1.5', spaceBefore: '8px', spaceAfter: '12px' })
  })

  it('rejects hostile / out-of-range values at parse (falls back to null)', () => {
    expect(
      parseStyle('paragraph', {
        lineHeight: '999); background:url(x',
        marginTop: '10000px',
        marginBottom: 'calc(100% + 1px)',
      }),
    ).toMatchObject({ lineHeight: null, spaceBefore: null, spaceAfter: null })
  })

  it('never serializes a hostile value back out (render-side sanitize)', () => {
    expect(
      toDOMStyle('paragraph', { lineHeight: '1); evil', spaceBefore: 'javascript:1' }),
    ).toBeUndefined()
  })

  it('round-trips the attrs through the Y.Doc <-> ProseMirror conversion', () => {
    // Non-null attrs survive; the null defaults are stripped from storage (same
    // as the v5 textAlign behavior), so the returned JSON omits them.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { textAlign: 'center', lineHeight: '1.5', spaceBefore: '8px', spaceAfter: null, level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          attrs: { textAlign: null, lineHeight: '2', spaceBefore: null, spaceAfter: '16px' },
          content: [{ type: 'text', text: 'body' }],
        },
      ],
    }
    const expected = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { textAlign: 'center', lineHeight: '1.5', spaceBefore: '8px', level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          attrs: { lineHeight: '2', spaceAfter: '16px' },
          content: [{ type: 'text', text: 'body' }],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(expected)
  })

  it('leaves a plain paragraph attr-free after round-trip (null defaults stripped)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
  })
})
