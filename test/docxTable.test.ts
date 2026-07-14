/**
 * Tests for table reconstruction (commit ④): OOXML w:tbl → ProseMirror table,
 * with merged-cell handling (gridSpan colspan + vMerge rowspan).
 */
import { describe, it, expect } from 'vitest'
import { walkDocument } from '../src/import/docx/document.js'

function doc(inner: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?><w:document xmlns:w="http://x"><w:body>${inner}</w:body></w:document>`,
    'utf8',
  )
}

/** A w:tc with plain text and optional tcPr XML. */
function tc(text: string, tcPr = ''): string {
  return `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
}
function tr(cells: string, trPr = ''): string {
  return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`
}
function tbl(rows: string, extra = ''): string {
  return `<w:tbl>${extra}${rows}</w:tbl>`
}

function table(out: ReturnType<typeof walkDocument>) {
  return out.content[0]!
}

describe('mapTable — basic grid', () => {
  it('scales a percentage-width table\'s columns up to the editor content width', () => {
    // Two DIFFERENT-width columns (non-uniform → author ratios) under a pct table
    // should scale up proportionally to fill the editor content width.
    const grid = '<w:tblGrid><w:gridCol w:w="6000"/><w:gridCol w:w="3000"/></w:tblGrid>'
    const tblPr = '<w:tblPr><w:tblW w:type="pct" w:w="100%"/></w:tblPr>'
    const xml = doc(tbl(tr(tc('a') + tc('b')) + tr(tc('c') + tc('d')), tblPr + grid))
    const t = table(walkDocument(xml, new Map()))
    const c0 = (t.content![0]!.content![0]!.attrs as { colwidth?: number[] }).colwidth!
    const c1 = (t.content![0]!.content![1]!.attrs as { colwidth?: number[] }).colwidth!
    // 6000/15=400, 3000/15=200, total 600 → scaled by 756/600 ≈ 504 / 252.
    expect(c0[0]! + c1[0]!).toBeGreaterThan(740)
    expect(c0[0]! + c1[0]!).toBeLessThanOrEqual(760)
    expect(c0[0]!).toBeGreaterThan(c1[0]!) // ratio preserved
  })

  it('drops colwidth for a uniform percentage-width table so it fills 100%', () => {
    // Even A4 distribution (both 4513) → no author ratios → fill full width.
    const grid = '<w:tblGrid><w:gridCol w:w="4513"/><w:gridCol w:w="4513"/></w:tblGrid>'
    const tblPr = '<w:tblPr><w:tblW w:type="pct" w:w="100%"/></w:tblPr>'
    const xml = doc(tbl(tr(tc('a') + tc('b')), tblPr + grid))
    const t = table(walkDocument(xml, new Map()))
    const attrs = (t.content![0]!.content![0]!.attrs ?? {}) as { colwidth?: number[] }
    expect(attrs.colwidth).toBeUndefined()
  })

  it('does not scale a fixed-width (dxa) table', () => {
    const grid = '<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>'
    const tblPr = '<w:tblPr><w:tblW w:type="dxa" w:w="3000"/></w:tblPr>'
    const xml = doc(tbl(tr(tc('a') + tc('b')), tblPr + grid))
    const t = table(walkDocument(xml, new Map()))
    const firstCell = t.content![0]!.content![0]!
    const colwidth = (firstCell.attrs as { colwidth?: number[] }).colwidth!
    expect(colwidth[0]).toBe(100) // 1500/15, unscaled
  })

  it('maps a 2x2 table', () => {
    const xml = doc(tbl(tr(tc('a') + tc('b')) + tr(tc('c') + tc('d'))))
    const t = table(walkDocument(xml, new Map()))
    expect(t.type).toBe('table')
    expect(t.content).toHaveLength(2)
    const firstCell = t.content![0]!.content![0]!
    expect(firstCell.type).toBe('tableCell')
    expect(firstCell.content![0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'a' }] })
  })

  it('marks the first row as headers when the table declares tblHeader', () => {
    const xml = doc(
      tbl(tr(tc('h1') + tc('h2'), '<w:tblHeader/>') + tr(tc('a') + tc('b'))),
    )
    const t = table(walkDocument(xml, new Map()))
    expect(t.content![0]!.content!.every((c) => c.type === 'tableHeader')).toBe(true)
    expect(t.content![1]!.content!.every((c) => c.type === 'tableCell')).toBe(true)
  })
})

describe('mapTable — horizontal merge (gridSpan)', () => {
  it('maps gridSpan to colspan', () => {
    const xml = doc(
      tbl(tr(tc('wide', '<w:gridSpan w:val="2"/>')) + tr(tc('a') + tc('b'))),
    )
    const t = table(walkDocument(xml, new Map()))
    const wide = t.content![0]!.content![0]!
    expect((wide.attrs as any).colspan).toBe(2)
    // Second row still has two normal cells.
    expect(t.content![1]!.content).toHaveLength(2)
  })
})

describe('mapTable — vertical merge (vMerge)', () => {
  it('collapses a vMerge restart+continue into a single rowspan=2 cell', () => {
    const xml = doc(
      tbl(
        tr(tc('merged', '<w:vMerge w:val="restart"/>') + tc('r1c2')) +
          tr(tc('', '<w:vMerge w:val="continue"/>') + tc('r2c2')),
      ),
    )
    const t = table(walkDocument(xml, new Map()))
    // Row 0: merged cell (rowspan 2) + r1c2. Row 1: only r2c2 (continue dropped).
    expect(t.content![0]!.content).toHaveLength(2)
    const merged = t.content![0]!.content![0]!
    expect((merged.attrs as any).rowspan).toBe(2)
    expect(t.content![1]!.content).toHaveLength(1)
    expect(t.content![1]!.content![0]!.content![0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'r2c2' }],
    })
  })

  it('treats a bare w:vMerge (no val) as continue', () => {
    const xml = doc(
      tbl(
        tr(tc('top', '<w:vMerge w:val="restart"/>')) + tr(tc('', '<w:vMerge/>')),
      ),
    )
    const t = table(walkDocument(xml, new Map()))
    expect((t.content![0]!.content![0]!.attrs as any).rowspan).toBe(2)
    // The continuation row had only a dropped cell → the row itself is omitted.
    expect(t.content).toHaveLength(1)
  })

  it('spans three rows (restart + two continues = rowspan 3)', () => {
    const xml = doc(
      tbl(
        tr(tc('m', '<w:vMerge w:val="restart"/>')) +
          tr(tc('', '<w:vMerge w:val="continue"/>')) +
          tr(tc('', '<w:vMerge w:val="continue"/>')),
      ),
    )
    const t = table(walkDocument(xml, new Map()))
    expect((t.content![0]!.content![0]!.attrs as any).rowspan).toBe(3)
  })
})

describe('mapTable — column widths', () => {
  it('reads tblGrid widths into colwidth (twips → px)', () => {
    const xml = doc(
      tbl(tr(tc('a') + tc('b')), '<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/></w:tblGrid>'),
    )
    const t = table(walkDocument(xml, new Map()))
    expect((t.content![0]!.content![0]!.attrs as any).colwidth).toEqual([100]) // 1500/15
    expect((t.content![0]!.content![1]!.attrs as any).colwidth).toEqual([200]) // 3000/15
  })

  it('sums covered columns for a colspan cell', () => {
    const xml = doc(
      tbl(
        tr(tc('wide', '<w:gridSpan w:val="2"/>')),
        '<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>',
      ),
    )
    const t = table(walkDocument(xml, new Map()))
    expect((t.content![0]!.content![0]!.attrs as any).colwidth).toEqual([100, 100])
  })
})
