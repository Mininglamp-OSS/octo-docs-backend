import { describe, it, expect } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'
import {
  prosemirrorJSONToYDocState,
  yDocStateToProsemirrorJSON,
} from '../src/agent/conversion.js'

// v16 adds a `fontFamily` ATTR on the existing `textStyle` mark, replicating the
// v7 `fontSize` path verbatim: same mark, a new style-backed attr, no new mark
// and no new node. textStyle now carries color (v3) + fontSize (v7) +
// fontFamily (v16), all riding the inline <span style="…"> serialization. This
// is the backend half of the @octo/docs-schema SCHEMA_VERSION 16 lockstep.
describe('Schema v16 (SCHEMA-SPEC §16: textStyle.fontFamily)', () => {
  it('reports SCHEMA_VERSION === 16', () => {
    expect(SCHEMA_VERSION).toBe(16)
  })

  it('carries the textStyle mark with color (v3) + fontSize (v7) + fontFamily (v16)', () => {
    const ts = buildSchema().marks.textStyle
    const m = ts.create({ color: '#abc', fontSize: '18px', fontFamily: 'Inter, sans-serif' })
    expect(m.attrs).toEqual({ color: '#abc', fontSize: '18px', fontFamily: 'Inter, sans-serif' })
  })

  it('defaults fontFamily to null when unset', () => {
    const ts = buildSchema().marks.textStyle
    const m = ts.create({ color: '#abc', fontSize: '18px' })
    expect(m.attrs.fontFamily).toBeNull()
  })

  // parseDOM: fontFamily is read from the inline `font-family` style, exactly
  // like color/fontSize. A span carrying ONLY font-family must match.
  it('parses font-family from a span style (matches on font-family alone)', () => {
    const schema = buildSchema()
    const rule = schema.marks.textStyle.spec.parseDOM!.find((r) => r.tag === 'span')!
    const attrs = rule.getAttrs!({ style: { fontFamily: 'Georgia, serif' } } as never)
    expect(attrs).toEqual({ color: null, fontSize: null, fontFamily: 'Georgia, serif' })
  })

  it('still refuses a bare span with no color/fontSize/fontFamily', () => {
    const schema = buildSchema()
    const rule = schema.marks.textStyle.spec.parseDOM!.find((r) => r.tag === 'span')!
    expect(rule.getAttrs!({ style: {} } as never)).toBe(false)
  })

  // toDOM: font-family serializes into the same inline style, after color and
  // font-size, so a mark carrying all three emits one combined style string.
  it('serializes fontFamily into the span style alongside color and fontSize', () => {
    const schema = buildSchema()
    const mark = schema.marks.textStyle.create({
      color: 'rgb(255, 0, 0)',
      fontSize: '32px',
      fontFamily: 'Inter, sans-serif',
    })
    const out = schema.marks.textStyle.spec.toDOM!(mark, false) as [string, Record<string, string>, number]
    expect(out[0]).toBe('span')
    expect(out[1]).toEqual({ style: 'color: rgb(255, 0, 0); font-size: 32px; font-family: Inter, sans-serif' })
  })

  it('serializes a fontFamily-only textStyle to <span style="font-family:…">', () => {
    const schema = buildSchema()
    const mark = schema.marks.textStyle.create({ fontFamily: 'Georgia, serif' })
    const out = schema.marks.textStyle.spec.toDOM!(mark, false) as [string, Record<string, string>, number]
    expect(out[1]).toEqual({ style: 'font-family: Georgia, serif' })
  })

  // The real proof: a fontFamily-bearing doc round-trips through the Y.Doc
  // binary path (prosemirrorJSONToYDocState -> Y.Doc -> yDocStateToProsemirrorJSON)
  // with NO attr loss — the same path version-restore / agent conversion use.
  it('round-trips textStyle fontFamily through the Y.Doc without loss', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'branded',
              marks: [
                {
                  type: 'textStyle',
                  attrs: { color: '#111', fontSize: '20px', fontFamily: 'Inter, sans-serif' },
                },
              ],
            },
          ],
        },
      ],
    }
    const schema = buildSchema()
    const node = PMNode.fromJSON(schema, doc as Parameters<typeof PMNode.fromJSON>[1])
    expect(() => node.check()).not.toThrow()
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
  })

  // Backward compatibility: a document authored under v15 (textStyle WITHOUT a
  // fontFamily key) must still decode. fromJSON fills the null default, and the
  // round-trip preserves the existing color/fontSize while surfacing fontFamily
  // as null — a new client reading an old doc sees no font, never a crash.
  it('reads a v15 doc that has no fontFamily key (backward compatible)', () => {
    const oldDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'legacy',
              marks: [{ type: 'textStyle', attrs: { color: '#222', fontSize: '14px' } }],
            },
          ],
        },
      ],
    }
    const schema = buildSchema()
    const node = PMNode.fromJSON(schema, oldDoc as Parameters<typeof PMNode.fromJSON>[1])
    expect(() => node.check()).not.toThrow()

    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(oldDoc)) as typeof oldDoc
    const mark = back.content[0].content[0].marks![0]
    expect(mark.attrs).toEqual({ color: '#222', fontSize: '14px', fontFamily: null })
  })

  // Regression guard: color and fontSize behaviour is unchanged when fontFamily
  // is absent — a color+fontSize-only mark still round-trips to exactly itself
  // (now including the fontFamily: null the new attr contributes).
  it('does not regress color+fontSize round-trip', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'styled',
              marks: [{ type: 'textStyle', attrs: { color: 'rgb(1, 2, 3)', fontSize: '12px', fontFamily: null } }],
            },
          ],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
  })
})
