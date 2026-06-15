import { describe, it, expect } from 'vitest'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'

describe('Schema v3 marks (SCHEMA-SPEC §3: highlight + textStyle)', () => {
  it('keeps SCHEMA_VERSION at or above 3 (now 4 with v4 tables; v3 marks carried)', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3)
    expect(SCHEMA_VERSION).toBe(4)
  })

  it('exposes the v3 marks alongside the carried-forward v2 marks', () => {
    const marks = buildSchema().marks
    expect(Object.keys(marks)).toEqual(
      expect.arrayContaining(['bold', 'italic', 'highlight', 'textStyle']),
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

  it('serializes a highlight mark with a color to <mark style="background-color:…">', () => {
    const schema = buildSchema()
    const mark = schema.marks.highlight.create({ color: '#ffcc00' })
    const out = schema.marks.highlight.spec.toDOM!(mark, false) as [string, Record<string, string>, number]
    expect(out[0]).toBe('mark')
    expect(out[1]).toEqual({ style: 'background-color: #ffcc00' })
    expect(JSON.stringify(out)).toContain('background-color')
  })

  it('serializes a highlight mark without a color to a bare <mark>', () => {
    const schema = buildSchema()
    const mark = schema.marks.highlight.create()
    const out = schema.marks.highlight.spec.toDOM!(mark, false) as [string, Record<string, string>, number]
    expect(out[0]).toBe('mark')
    expect(out[1]).toEqual({})
  })

  it('serializes a textStyle mark with a color to <span style="color:…">', () => {
    const schema = buildSchema()
    const mark = schema.marks.textStyle.create({ color: 'rgb(255, 0, 0)' })
    const out = schema.marks.textStyle.spec.toDOM!(mark, false) as [string, Record<string, string>, number]
    expect(out[0]).toBe('span')
    expect(out[1]).toEqual({ style: 'color: rgb(255, 0, 0)' })
    expect(JSON.stringify(out)).toContain('color')
  })

  it('does not let a colorless textStyle span match on parse (getAttrs returns false)', () => {
    const schema = buildSchema()
    const rule = schema.marks.textStyle.spec.parseDOM!.find((r) => r.tag === 'span')!
    const colorless = rule.getAttrs!({ style: {} } as never)
    expect(colorless).toBe(false)
    const colored = rule.getAttrs!({ style: { color: 'red' } } as never)
    expect(colored).toEqual({ color: 'red' })
  })
})
