import { describe, it, expect } from 'vitest'
import { makeDeadline, walkDocument, type RelMap } from '../src/import/docx/document.js'
import { DocxUnsafeError } from '../src/import/docx/extract.js'

describe('makeDeadline', () => {
  it('does not trip while within budget', () => {
    const d = makeDeadline(60_000)
    expect(() => d.check()).not.toThrow()
  })

  it('trips with a timeout DocxUnsafeError once the budget is spent', () => {
    // A zero/negative-adjusted budget: build a deadline already in the past by
    // spending it. A 0ms budget maps to Infinity (never trips), so use a tiny
    // positive budget and wait it out.
    const d = makeDeadline(1)
    const start = Date.now()
    while (Date.now() <= start + 2) {
      // busy-wait ~2ms so the 1ms budget is definitely exceeded
    }
    let err: unknown
    try {
      d.check()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DocxUnsafeError)
    expect((err as DocxUnsafeError).reason).toBe('timeout')
  })

  it('treats a non-positive budget as "never trips"', () => {
    const d = makeDeadline(0)
    expect(() => d.check()).not.toThrow()
  })
})

describe('parse deadline reaches the inline/run inner loop', () => {
  // A single paragraph holding a run-storm (tens of thousands of w:r) must not
  // expand in one uninterrupted synchronous pass — the deadline check inside
  // collectInline has to fire mid-block, not only between blocks.
  function runStormDoc(runs: number): Buffer {
    const r = '<w:r><w:t>x</w:t></w:r>'.repeat(runs)
    return Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${r}</w:p></w:body></w:document>`,
    )
  }

  it('trips a spent deadline inside a single massive paragraph', () => {
    const rels: RelMap = new Map()
    const doc = runStormDoc(5000)
    // Deadline already spent: any mid-block check must throw timeout.
    const d = makeDeadline(1)
    const start = Date.now()
    while (Date.now() <= start + 3) {
      // busy-wait so the 1ms budget is definitely exceeded before walking
    }
    let err: unknown
    try {
      walkDocument(doc, rels, undefined, d)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DocxUnsafeError)
    expect((err as DocxUnsafeError).reason).toBe('timeout')
  })

  it('completes a single massive paragraph within a generous budget', () => {
    const rels: RelMap = new Map()
    const out = walkDocument(runStormDoc(2000), rels, undefined, makeDeadline(60_000))
    expect(out.content.length).toBeGreaterThan(0)
  })
})

describe('parse deadline reaches the table row/cell loop', () => {
  // A table of many EMPTY / vMerge="continue" cells trips no cell-content
  // callback, so the deadline must be ticked inside mapTable's own row/cell
  // walk — otherwise such a table spins uninterrupted.
  function emptyCellTableDoc(rows: number, cols: number): Buffer {
    // Each cell is empty and marked vMerge="continue" so the content callback
    // is skipped entirely — the worst case for the row/cell loop guard.
    const tc =
      '<w:tc><w:tcPr><w:vMerge w:val="continue"/></w:tcPr></w:tc>'.repeat(cols)
    const tr = `<w:tr>${tc}</w:tr>`.repeat(rows)
    return Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>${tr}</w:tbl></w:body></w:document>`,
    )
  }

  it('trips a spent deadline inside a table of empty continuation cells', () => {
    const rels: RelMap = new Map()
    const doc = emptyCellTableDoc(400, 40) // 16k empty/continue cells
    const d = makeDeadline(1)
    const start = Date.now()
    while (Date.now() <= start + 3) {
      // busy-wait so the 1ms budget is spent before walking
    }
    let err: unknown
    try {
      walkDocument(doc, rels, undefined, d)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DocxUnsafeError)
    expect((err as DocxUnsafeError).reason).toBe('timeout')
  })

  it('completes a large empty-cell table within a generous budget', () => {
    const rels: RelMap = new Map()
    const out = walkDocument(emptyCellTableDoc(50, 20), rels, undefined, makeDeadline(60_000))
    expect(out.content.length).toBeGreaterThan(0)
  })
})
