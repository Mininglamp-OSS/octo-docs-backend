import { describe, it, expect } from 'vitest'
import {
  parseDocumentName,
  buildDocumentName,
  buildHtmlDocumentName,
  DocumentNameError,
} from '../src/permission/documentName.js'

describe('parseDocumentName matrix (§4.1 step 5 / §8.1 / appendix B)', () => {
  it('parses a valid 4-segment document key', () => {
    const parsed = parseDocumentName('octo:s_001:f_888:d_abc123')
    expect(parsed).toEqual({ kind: 'document', space: 's_001', folder: 'f_888', doc: 'd_abc123' })
  })

  it('parses a 5-segment whiteboard key (parts[3]==="wb") as whiteboard', () => {
    const parsed = parseDocumentName('octo:s_001:f_888:wb:board_1')
    expect(parsed).toEqual({ kind: 'whiteboard', space: 's_001', folder: 'f_888', board: 'board_1' })
  })

  it('parses a 5-segment html registration key (parts[3]==="html") as html', () => {
    const parsed = parseDocumentName('octo:s_001:f_888:html:d_html1')
    expect(parsed).toEqual({ kind: 'html', space: 's_001', folder: 'f_888', doc: 'd_html1' })
  })

  it('rejects {doc} === "wb" (ambiguous with whiteboard prefix)', () => {
    expect(() => parseDocumentName('octo:s_001:f_888:wb')).toThrow(DocumentNameError)
  })

  it('rejects an empty folder segment', () => {
    expect(() => parseDocumentName('octo:s_001::d_abc123')).toThrow(DocumentNameError)
  })

  it('rejects an empty space segment', () => {
    expect(() => parseDocumentName('octo::f_888:d_abc123')).toThrow(DocumentNameError)
  })

  it('rejects when first segment is not "octo"', () => {
    expect(() => parseDocumentName('xx:s_001:f_888:d_abc123')).toThrow(DocumentNameError)
  })

  it('rejects too few segments (3)', () => {
    expect(() => parseDocumentName('octo:s_001:d_abc123')).toThrow(DocumentNameError)
  })

  it('rejects too many segments (5 not wb)', () => {
    expect(() => parseDocumentName('octo:s_001:f_888:d_abc:extra')).toThrow(DocumentNameError)
  })

  it('rejects illegal characters (segment contains a space)', () => {
    expect(() => parseDocumentName('octo:s 1:f_888:d_abc')).toThrow(DocumentNameError)
  })

  it('5-segment with parts[3] !== "wb" is rejected (not a whiteboard, wrong arity)', () => {
    expect(() => parseDocumentName('octo:s_001:f_888:nope:board')).toThrow(DocumentNameError)
  })
})

describe('buildDocumentName (§8.1)', () => {
  it('builds a valid key and round-trips through parseDocumentName', () => {
    const name = buildDocumentName('s_001', 'f_888', 'd_abc123')
    expect(name).toBe('octo:s_001:f_888:d_abc123')
    expect(parseDocumentName(name)).toMatchObject({ kind: 'document', folder: 'f_888' })
  })

  it('refuses to build a key whose doc segment is "wb"', () => {
    expect(() => buildDocumentName('s_001', 'f_888', 'wb')).toThrow(DocumentNameError)
  })

  it('refuses illegal segment characters', () => {
    expect(() => buildDocumentName('s_001', 'f 888', 'd_abc')).toThrow(DocumentNameError)
  })
})

describe('buildHtmlDocumentName', () => {
  it('builds a 5-segment :html: key without changing doc/board key formats', () => {
    const name = buildHtmlDocumentName('s_001', 'f_888', 'd_abc123')
    expect(name).toBe('octo:s_001:f_888:html:d_abc123')
    expect(parseDocumentName(name)).toEqual({ kind: 'html', space: 's_001', folder: 'f_888', doc: 'd_abc123' })
    expect(buildDocumentName('s_001', 'f_888', 'd_abc123')).toBe('octo:s_001:f_888:d_abc123')
  })
})
