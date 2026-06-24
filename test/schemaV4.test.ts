import { describe, it, expect } from 'vitest'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'

describe('Schema v4 nodes (SCHEMA-SPEC §4: table/tableRow/tableCell/tableHeader)', () => {
  it('keeps SCHEMA_VERSION at the current value (now 15 after the v15 co-land; v4 tables carried)', () => {
    expect(SCHEMA_VERSION).toBe(15)
  })

  it('exposes the v4 table nodes', () => {
    const nodes = buildSchema().nodes
    expect(Object.keys(nodes)).toEqual(
      expect.arrayContaining(['table', 'tableRow', 'tableCell', 'tableHeader']),
    )
  })

  it('carries the v2 image node forward (cumulative, not dropped)', () => {
    const nodes = buildSchema().nodes
    expect(nodes).toHaveProperty('image')
    // Core nodes still present too.
    expect(nodes).toHaveProperty('doc')
    expect(nodes).toHaveProperty('paragraph')
    expect(nodes).toHaveProperty('heading')
    expect(nodes).toHaveProperty('text')
  })

  it('carries the v3/v1 marks forward (highlight, textStyle, bold, italic)', () => {
    const marks = buildSchema().marks
    expect(Object.keys(marks)).toEqual(
      expect.arrayContaining(['bold', 'italic', 'highlight', 'textStyle']),
    )
  })

  it('gives tableCell and tableHeader the colspan/rowspan/colwidth attrs', () => {
    const schema = buildSchema()
    for (const name of ['tableCell', 'tableHeader']) {
      const cell = schema.nodes[name].createAndFill()!
      expect(cell.attrs).toHaveProperty('colspan', 1)
      expect(cell.attrs).toHaveProperty('rowspan', 1)
      expect(cell.attrs).toHaveProperty('colwidth', null)
    }
  })

  it('sets table role / isolating metadata to mirror prosemirror-tables', () => {
    const schema = buildSchema()
    expect(schema.nodes.table.spec.tableRole).toBe('table')
    expect(schema.nodes.tableRow.spec.tableRole).toBe('row')
    expect(schema.nodes.tableCell.spec.tableRole).toBe('cell')
    expect(schema.nodes.tableHeader.spec.tableRole).toBe('header_cell')
    expect(schema.nodes.table.spec.isolating).toBe(true)
    expect(schema.nodes.tableCell.spec.isolating).toBe(true)
  })

  it('serializes a default cell to a bare <td> / <th> (colspan/rowspan omitted when 1)', () => {
    const schema = buildSchema()
    const td = schema.nodes.tableCell.createAndFill()!
    const tdOut = schema.nodes.tableCell.spec.toDOM!(td) as [string, Record<string, string>, number]
    expect(tdOut[0]).toBe('td')
    expect(tdOut[1]).toEqual({})
    const th = schema.nodes.tableHeader.createAndFill()!
    const thOut = schema.nodes.tableHeader.spec.toDOM!(th) as [string, Record<string, string>, number]
    expect(thOut[0]).toBe('th')
    expect(thOut[1]).toEqual({})
  })

  it('serializes a spanning cell with colspan/rowspan and data-colwidth', () => {
    const schema = buildSchema()
    const cell = schema.nodes.tableCell.create({ colspan: 2, rowspan: 3, colwidth: [120, 80] })
    const out = schema.nodes.tableCell.spec.toDOM!(cell) as [string, Record<string, string>, number]
    expect(out[0]).toBe('td')
    expect(out[1]).toEqual({ colspan: '2', rowspan: '3', 'data-colwidth': '120,80' })
  })

  it('parses colspan/rowspan/data-colwidth back off a <td> element', () => {
    const schema = buildSchema()
    const rule = schema.nodes.tableCell.spec.parseDOM!.find((r) => r.tag === 'td')!
    const attrs = {
      colspan: '2',
      rowspan: '3',
      'data-colwidth': '120,80',
    } as Record<string, string>
    const parsed = rule.getAttrs!({ getAttribute: (n: string) => attrs[n] ?? null } as never)
    expect(parsed).toEqual({ colspan: 2, rowspan: 3, colwidth: [120, 80], align: null })
  })

  it('drops data-colwidth whose length does not match colspan (prosemirror-tables guard)', () => {
    const schema = buildSchema()
    const rule = schema.nodes.tableCell.spec.parseDOM!.find((r) => r.tag === 'td')!
    const attrs = { colspan: '1', 'data-colwidth': '120,80' } as Record<string, string>
    const parsed = rule.getAttrs!({ getAttribute: (n: string) => attrs[n] ?? null } as never)
    expect(parsed).toEqual({ colspan: 1, rowspan: 1, colwidth: null, align: null })
  })

  it('builds and validates a table > tableRow > (tableHeader|tableCell) > paragraph document', () => {
    const schema = buildSchema()
    const para = schema.nodes.paragraph.createAndFill()!
    const header = schema.nodes.tableHeader.create(null, para)
    const cell = schema.nodes.tableCell.create(null, schema.nodes.paragraph.createAndFill()!)
    const row = schema.nodes.tableRow.create(null, [header, cell])
    const table = schema.nodes.table.create(null, row)
    const doc = schema.nodes.doc.create(null, table)
    expect(() => doc.check()).not.toThrow()
    expect(doc.firstChild!.type.name).toBe('table')
    expect(doc.firstChild!.firstChild!.type.name).toBe('tableRow')
    // createAndFill must also succeed for a bare table (fills a row + cells).
    expect(schema.nodes.table.createAndFill()).not.toBeNull()
  })
})
