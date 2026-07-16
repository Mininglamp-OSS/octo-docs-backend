import { describe, it, expect } from 'vitest'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'
import {
  prosemirrorJSONToYDocState,
  yDocStateToProsemirrorJSON,
} from '../src/agent/conversion.js'

// v19 (SCHEMA-SPEC §18): `tableRow` gains a `height` attr (number | null, default
// null) so the front-end row-height drag handle can persist a per-row height.
// A set height serializes to the inline style `height:Npx` on the <tr>; a null
// height emits a bare <tr> (unchanged from v18, so the row is content-sized and
// existing docs never regress). parseDOM reads the integer px back off the tr's
// inline height style. The unit is fixed px and the value is an integer SCALAR
// (one value per row, unlike colwidth's number[]). This is the backend half of
// the @octo/docs-schema SCHEMA_VERSION 19 lockstep with the front-end.
describe('Schema v19 tableRow.height attr', () => {
  const schema = buildSchema()

  function rowToDOM(attrs: Record<string, unknown>): [string, ...unknown[]] {
    const node = schema.nodes.tableRow.create(attrs)
    return schema.nodes.tableRow.spec.toDOM!(node) as [string, ...unknown[]]
  }

  function parseRowAttrs(style: Record<string, string>): Record<string, unknown> {
    const rule = schema.nodes.tableRow.spec.parseDOM!.find((r) => r.tag === 'tr')!
    const el = {
      style,
      getAttribute: () => null,
    }
    return rule.getAttrs!(el as never) as Record<string, unknown>
  }

  it('reports SCHEMA_VERSION === 19 (monotonic bump over v18, no gaps)', () => {
    expect(SCHEMA_VERSION).toBe(19)
  })

  it('registers the height attr (default null) on tableRow', () => {
    const attrs = schema.nodes.tableRow.spec.attrs!
    expect(attrs.height).toBeDefined()
    expect(attrs.height.default).toBe(null)
    // A freshly filled row carries the null default.
    expect(schema.nodes.tableRow.createAndFill()!.attrs.height).toBe(null)
  })

  it('does NOT disturb the other v18 nodes/marks (v19 is a strict superset)', () => {
    const nodes = buildSchema().nodes
    expect(Object.keys(nodes)).toEqual(
      expect.arrayContaining(['table', 'tableRow', 'tableCell', 'tableHeader']),
    )
    // tableCell still owns colwidth as a number[] (scalar height is row-only).
    expect(nodes.tableCell.spec.attrs).toHaveProperty('colwidth')
    expect(nodes.tableRow.spec.attrs).not.toHaveProperty('colwidth')
  })

  it('serializes a set height to the inline height:Npx style on the tr', () => {
    const out = rowToDOM({ height: 42 })
    expect(out[0]).toBe('tr')
    expect(out[1]).toEqual({ style: 'height:42px' })
    expect(out[2]).toBe(0)
  })

  it('emits a bare <tr> (no style) when height is null — unchanged from v18', () => {
    const out = rowToDOM({})
    expect(out[0]).toBe('tr')
    expect(out[1]).toBe(0)
    expect(out.length).toBe(2)
  })

  it('parses an integer px height back off the tr inline style', () => {
    expect(parseRowAttrs({ height: '42px' })).toMatchObject({ height: 42 })
    // No inline height -> null (row stays content-sized).
    expect(parseRowAttrs({})).toMatchObject({ height: null })
    // A non-px / malformed height does not smuggle a value in.
    expect(parseRowAttrs({ height: 'auto' })).toMatchObject({ height: null })
  })

  it('round-trips a set row height through Y.Doc <-> ProseMirror conversion', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              attrs: { height: 64 },
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc)) as {
      content: { content: { attrs: Record<string, unknown> }[] }[]
    }
    const row = back.content[0].content[0]
    expect(row.attrs.height).toBe(64)
  })

  it('keeps a height-less row attr-equivalent to v18 after round-trip (null height)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc)) as {
      content: { content: { attrs?: Record<string, unknown> }[] }[]
    }
    const row = back.content[0].content[0]
    // A default (null) height normalizes away entirely — the row carries no
    // height attr, byte-identical to a v18 row, so old docs never regress.
    expect(row.attrs?.height ?? null).toBe(null)
    expect(JSON.stringify(back)).not.toContain('height')
  })
})
