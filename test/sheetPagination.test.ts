import { describe, it, expect } from 'vitest'
import {
  compareCellKeys,
  sortedCellKeys,
  encodeSheetCursor,
  decodeSheetCursor,
  InvalidSheetCursorError,
  paginateSheetCells,
} from '../src/api/services/sheetPagination.js'
import type { SheetCell } from '../src/agent/sheetConversion.js'

// Pure-module unit tests: no live infra, no HTTP. Exercises the cursor codec and
// the byte/count-bounded slicing that the GET /:docId/sheet paginated read is
// built on, so the paging invariants are pinned independently of the route.

describe('compareCellKeys — canonical (sheetId, row, col) order', () => {
  it('orders row/col numerically, not lexically', () => {
    // A raw string sort would place "default!10:0" before "default!2:0"; the
    // numeric order must not.
    const keys = ['default!10:0', 'default!2:0', 'default!2:10', 'default!2:2']
    expect(keys.slice().sort(compareCellKeys)).toEqual([
      'default!2:0',
      'default!2:2',
      'default!2:10',
      'default!10:0',
    ])
  })

  it('orders sheetId lexically before row/col', () => {
    const keys = ['s2!0:0', 's1!100:100', 's1!0:0']
    expect(keys.slice().sort(compareCellKeys)).toEqual(['s1!0:0', 's1!100:100', 's2!0:0'])
  })

  it('sortedCellKeys returns the map keys in canonical order', () => {
    const cells: Record<string, SheetCell> = {
      'default!5:0': { v: 'e' },
      'default!1:0': { v: 'a' },
      'default!1:2': { v: 'b' },
    }
    expect(sortedCellKeys(cells)).toEqual(['default!1:0', 'default!1:2', 'default!5:0'])
  })
})

describe('sheet cursor codec', () => {
  it('round-trips a cursor through encode/decode', () => {
    const token = encodeSheetCursor({ v: 'BASE_V==', k: 'default!3:4' })
    expect(decodeSheetCursor(token)).toEqual({ v: 'BASE_V==', k: 'default!3:4' })
  })

  it('produces an opaque token (not the raw key)', () => {
    const token = encodeSheetCursor({ v: 'BASE_V==', k: 'default!3:4' })
    expect(token).not.toContain('default!3:4')
  })

  it('rejects a non-base64url / non-JSON token', () => {
    expect(() => decodeSheetCursor('!!!not base64!!!')).toThrow(InvalidSheetCursorError)
    // Valid base64url of a non-JSON string.
    const notJson = Buffer.from('hello', 'utf8').toString('base64url')
    expect(() => decodeSheetCursor(notJson)).toThrow(InvalidSheetCursorError)
  })

  it('rejects a token missing v or k', () => {
    const missingK = Buffer.from(JSON.stringify({ v: 'x' }), 'utf8').toString('base64url')
    const blankV = Buffer.from(JSON.stringify({ v: '', k: 'default!0:0' }), 'utf8').toString('base64url')
    expect(() => decodeSheetCursor(missingK)).toThrow(InvalidSheetCursorError)
    expect(() => decodeSheetCursor(blankV)).toThrow(InvalidSheetCursorError)
  })
})

describe('paginateSheetCells — count + byte bounded slicing', () => {
  const cells: Record<string, SheetCell> = {}
  for (let r = 0; r < 10; r++) cells[`default!${r}:0`] = { v: `row-${r}` }

  it('first page: emits up to `limit` cells in canonical order and reports hasMore', () => {
    const page = paginateSheetCells(cells, null, 3, 1_000_000)
    expect(Object.keys(page.cells)).toEqual(['default!0:0', 'default!1:0', 'default!2:0'])
    expect(page.lastKey).toBe('default!2:0')
    expect(page.hasMore).toBe(true)
  })

  it('walks the whole sheet across pages with no gap or overlap', () => {
    const seen: string[] = []
    let afterKey: string | null = null
    let guard = 0
    for (;;) {
      const page = paginateSheetCells(cells, afterKey, 3, 1_000_000)
      seen.push(...Object.keys(page.cells))
      if (!page.hasMore) break
      afterKey = page.lastKey
      if (++guard > 100) throw new Error('pagination did not terminate')
    }
    expect(seen).toEqual(sortedCellKeys(cells))
    // No duplicates.
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('the last page reports hasMore=false', () => {
    const page = paginateSheetCells(cells, 'default!7:0', 100, 1_000_000)
    expect(Object.keys(page.cells)).toEqual(['default!8:0', 'default!9:0'])
    expect(page.hasMore).toBe(false)
  })

  it('bounds a page by maxBytes even when the count limit is higher', () => {
    // A tiny byte cap forces far fewer cells than the count limit of 100.
    const page = paginateSheetCells(cells, null, 100, 40)
    expect(Object.keys(page.cells).length).toBeLessThan(10)
    expect(page.hasMore).toBe(true)
  })

  it('always emits at least one cell so the walk makes progress under a tiny cap', () => {
    // maxBytes below a single entry: the first cell is still emitted (progress
    // guarantee), else a walk could stall forever returning empty pages.
    const page = paginateSheetCells(cells, null, 100, 1)
    expect(Object.keys(page.cells)).toEqual(['default!0:0'])
    expect(page.hasMore).toBe(true)
  })

  it('empty sheet: empty page, no cursor, no more', () => {
    const page = paginateSheetCells({}, null, 10, 1_000_000)
    expect(page.cells).toEqual({})
    expect(page.lastKey).toBeNull()
    expect(page.hasMore).toBe(false)
  })
})
