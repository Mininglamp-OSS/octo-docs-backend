/**
 * Tests for math reconstruction (commit ⑤): OMML → LaTeX, and the round-trip
 * validation 红猫 called out — our own exported formulas must import back to
 * (semantically) the same LaTeX.
 */
import { describe, it, expect } from 'vitest'
import { ommlToLatex, mathNode } from '../src/import/docx/math.js'
import { walkDocument } from '../src/import/docx/document.js'

const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

/** OMML fixtures shaped like what the exporter (MathJax→mathmlToOmml) emits. */
const OMML = {
  // x^2
  superscript: `<m:oMath ${M}><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>`,
  // a/b
  fraction: `<m:oMath ${M}><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath>`,
  // a_i (subscript)
  subscript: `<m:oMath ${M}><m:sSub><m:e><m:r><m:t>a</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub></m:oMath>`,
}

describe('ommlToLatex — conversion', () => {
  it('converts a superscript', () => {
    expect(ommlToLatex(OMML.superscript)).toBe('x^{2}')
  })

  it('converts a fraction', () => {
    expect(ommlToLatex(OMML.fraction)).toBe('\\frac{a}{b}')
  })

  it('converts a subscript', () => {
    expect(ommlToLatex(OMML.subscript)).toBe('a_{i}')
  })

  it('injects the m: namespace when missing', () => {
    const noNs = OMML.fraction.replace(` ${M}`, '')
    expect(ommlToLatex(noNs)).toBe('\\frac{a}{b}')
  })

  it('returns null for unparseable / empty OMML', () => {
    expect(ommlToLatex('not omml at all')).toBeNull()
    expect(ommlToLatex(`<m:oMath ${M}></m:oMath>`)).toBeNull()
  })
})

/**
 * Round-trip: normalise LaTeX (strip whitespace + redundant single-char braces)
 * so semantically equal expressions compare equal. The export side emits e.g.
 * `x^{2}`; a hand-simplified `x^2` is the same formula.
 */
function normLatex(s: string): string {
  return s.replace(/\s+/g, '').replace(/\{([a-zA-Z0-9])\}/g, '$1')
}

describe('round-trip — exported LaTeX survives OMML import', () => {
  // (exported-LaTeX, OMML the exporter produces for it). We assert the imported
  // LaTeX is SEMANTICALLY the original. OMML fixtures mirror mathmlToOmml output.
  const cases: Array<[string, string]> = [
    ['x^2', OMML.superscript],
    ['\\frac{a}{b}', OMML.fraction],
    ['a_i', OMML.subscript],
  ]

  for (const [original, omml] of cases) {
    it(`round-trips ${original}`, () => {
      const imported = ommlToLatex(omml)
      expect(imported).not.toBeNull()
      expect(normLatex(imported!)).toBe(normLatex(original))
    })
  }
})

describe('mathNode', () => {
  it('builds block vs inline math nodes', () => {
    expect(mathNode('x^2', true)).toEqual({ type: 'blockMath', attrs: { latex: 'x^2' } })
    expect(mathNode('x^2', false)).toEqual({ type: 'inlineMath', attrs: { latex: 'x^2' } })
  })
})

describe('walkDocument — math integration', () => {
  function doc(inner: string): Buffer {
    return Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://x" ${M}><w:body>${inner}</w:body></w:document>`,
      'utf8',
    )
  }

  it('maps inline m:oMath inside a paragraph to an inlineMath node', () => {
    const inner = `<w:p><w:r><w:t>see </w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></w:p>`
    const out = walkDocument(doc(inner), new Map())
    const para = out.content[0]!
    expect(para.type).toBe('paragraph')
    expect(para.content![0]).toEqual({ type: 'text', text: 'see ' })
    expect(para.content![1]).toEqual({ type: 'inlineMath', attrs: { latex: '\\frac{a}{b}' } })
  })

  it('maps a lone m:oMath paragraph to a blockMath node', () => {
    const inner = `<w:p><m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></w:p>`
    const out = walkDocument(doc(inner), new Map())
    expect(out.content[0]).toEqual({ type: 'blockMath', attrs: { latex: 'x^{2}' } })
  })

  it('maps m:oMathPara at block level to blockMath', () => {
    const inner = `<m:oMathPara><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>`
    const out = walkDocument(doc(inner), new Map())
    expect(out.content[0]).toEqual({ type: 'blockMath', attrs: { latex: '\\frac{a}{b}' } })
  })
})
