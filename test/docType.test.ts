import { describe, it, expect } from 'vitest'
import { DOC_TYPES, isDocType, normalizeTypeFilter } from '../src/db/docType.js'

// FEAT-B/XIN-1188 type-filter enum. The wire values MUST stay in lockstep with the frontend
// DOC_TYPES (octo-web docsApi.ts); this pins the canonical set + the query-param normalizer.
describe('docType enum (XIN-1188)', () => {
  it('exposes exactly the four canonical kinds', () => {
    expect([...DOC_TYPES]).toEqual(['doc', 'sheet', 'board', 'html'])
  })

  it('isDocType accepts the enum values and rejects everything else', () => {
    expect(isDocType('doc')).toBe(true)
    expect(isDocType('sheet')).toBe(true)
    expect(isDocType('board')).toBe(true)
    expect(isDocType('html')).toBe(true)
    expect(isDocType('slides')).toBe(false)
    expect(isDocType('')).toBe(false)
    expect(isDocType(undefined)).toBe(false)
    expect(isDocType(3)).toBe(false)
  })
})

describe('normalizeTypeFilter — repeated ?type= param', () => {
  it('keeps a single string value', () => {
    expect(normalizeTypeFilter('sheet')).toEqual(['sheet'])
  })

  it('keeps a repeated-param array, preserving order', () => {
    expect(normalizeTypeFilter(['board', 'doc'])).toEqual(['board', 'doc'])
  })

  it('drops unknown values rather than rejecting (fixed candidate set)', () => {
    expect(normalizeTypeFilter(['doc', 'slides', 'x'])).toEqual(['doc'])
  })

  it('de-duplicates repeated kinds', () => {
    expect(normalizeTypeFilter(['doc', 'doc', 'sheet'])).toEqual(['doc', 'sheet'])
  })

  it('absent / only-unknown / non-string input yields [] (=> no filter, backward compatible)', () => {
    expect(normalizeTypeFilter(undefined)).toEqual([])
    expect(normalizeTypeFilter('slides')).toEqual([])
    expect(normalizeTypeFilter(['nope'])).toEqual([])
    expect(normalizeTypeFilter(42)).toEqual([])
  })
})
