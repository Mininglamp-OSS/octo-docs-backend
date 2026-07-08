import { describe, it, expect } from 'vitest'
import { renderTypst, __test } from '../src/export/renderTypst.js'
import type { ResolvedAttachment } from '../src/export/renderTypst.js'

// ── helpers ────────────────────────────────────────────────────────────────
const doc = (content: unknown[]) => ({ type: 'doc', content })
const para = (content: unknown[]) => ({ type: 'paragraph', content })
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })

function typ(content: unknown[], attachments = new Map<string, ResolvedAttachment>()): string {
  return renderTypst(doc(content), { title: 'T', attachments })
}

const m = __test.latexToTypstMath

// ── LaTeX -> Typst math conversion ───────────────────────────────────────────
describe('renderTypst — latexToTypstMath', () => {
  it('converts fractions without spurious visible parens', () => {
    expect(m('\\frac{a}{b}')).toBe('frac(a, b)')
    expect(m('\\frac{1}{n^2}')).toBe('frac(1, n^2)')
  })

  it('converts scripts, grouping multi-atom exponents only', () => {
    expect(m('x^2')).toBe('x^2')
    expect(m('x^{2n}')).toBe('x^(2n)')
    expect(m('x_{i}')).toBe('x_i')
  })

  it('maps greek letters and common operators', () => {
    expect(m('\\alpha')).toBe('alpha')
    expect(m('\\pi')).toBe('pi')
    expect(m('a \\leq b')).toBe('a lt.eq b')
    expect(m('a \\times b')).toBe('a times b')
    expect(m('\\infty')).toBe('infinity')
  })

  it('converts sqrt, nth-root, and binom', () => {
    expect(m('\\sqrt{x+1}')).toBe('sqrt(x+1)')
    expect(m('\\sqrt[3]{x}')).toBe('root(3, x)')
    expect(m('\\binom{n}{k}')).toBe('binom(n, k)')
  })

  it('converts sum with limits', () => {
    expect(m('\\sum_{n=1}^{\\infty}')).toBe('sum_(n=1)^(infinity)')
  })

  it('wraps \\text{...} as a Typst string literal', () => {
    expect(m('\\text{hello}')).toBe('"hello"')
  })

  it('quotes unknown multi-letter commands as text so Typst never errors', () => {
    // A bare multi-letter ident is an "unknown variable" error in Typst math, so
    // unknown commands are emitted as an upright text string (always compiles).
    expect(m('\\foobar')).toBe('"foobar"')
  })

  it('drops alignment tabs and comments', () => {
    expect(m('a & b')).toBe('a  b')
    expect(m('a % comment')).toBe('a ')
  })
})

// ── inline mark rendering ────────────────────────────────────────────────────
describe('renderTypst — marks', () => {
  it('renders bold/italic/underline/strike/sup/sub as Typst functions', () => {
    expect(__test.wrapMark({ type: 'bold' }, 'x')).toBe('#text(weight: "bold")[x]')    // Italic on CJK: skew-synthesized slant wrapping an emph (Latin still italic).
    expect(__test.wrapMark({ type: 'italic' }, 'x')).toBe('#box(skew(ax: -12deg)[#emph[x]])')
    expect(__test.wrapMark({ type: 'underline' }, 'x')).toBe('#underline[x]')
    expect(__test.wrapMark({ type: 'strike' }, 'x')).toBe('#strike[x]')
    expect(__test.wrapMark({ type: 'superscript' }, 'x')).toBe('#super[x]')
    expect(__test.wrapMark({ type: 'subscript' }, 'x')).toBe('#sub[x]')
  })

  it('only emits safe link hrefs, else plain text', () => {
    expect(__test.wrapMark({ type: 'link', attrs: { href: 'https://x.com' } }, 'a')).toBe('#link("https://x.com")[a]')
    // javascript: is unsafe -> plain text
    expect(__test.wrapMark({ type: 'link', attrs: { href: 'javascript:alert(1)' } }, 'a')).toBe('a')
    expect(__test.wrapMark({ type: 'link', attrs: { href: 'java\tscript:alert(1)' } }, 'a')).toBe('a')
  })

  it('applies code mark innermost so bold+code does not leak Typst source', () => {
    // Regression: a run with BOTH bold and code marks must not feed generated
    // markup like #text(weight:"bold")[..] into #raw(); the code chip should
    // wrap the plain text, then bold wraps the chip.
    const out = __test.renderTextNode({
      type: 'text',
      text: 'BoldCode',
      marks: [{ type: 'bold' }, { type: 'code' }],
    })
    expect(out).toContain('#raw("BoldCode")')
    expect(out).not.toContain('#raw("#text')
    expect(out.startsWith('#text(weight: "bold")[')).toBe(true)
  })

  it('whitelists highlight/textStyle colours and sizes', () => {
    expect(__test.wrapMark({ type: 'highlight', attrs: { color: '#ff0' } }, 'x')).toContain('#highlight(fill: rgb("#ff0"))')
    // unsafe colour -> plain highlight, no injection
    expect(__test.wrapMark({ type: 'highlight', attrs: { color: 'red;position:fixed' } }, 'x')).toBe('#highlight[x]')
    const ts = __test.wrapMark({ type: 'textStyle', attrs: { color: 'red', fontSize: '16px' } }, 'x')
    expect(ts).toContain('fill: red')
    expect(ts).toContain('size: 12.00pt') // 16px * 0.75
  })

  it('cssColorToTypst rejects unknown/dangerous values', () => {
    expect(__test.cssColorToTypst('#abc')).toBe('rgb("#abc")')
    expect(__test.cssColorToTypst('rgb(1,2,3)')).toBe('rgb(1, 2, 3)')
    expect(__test.cssColorToTypst('red')).toBe('red')
    expect(__test.cssColorToTypst('expression(alert(1))')).toBeNull()
  })
})

// ── escaping / injection safety ──────────────────────────────────────────────
describe('renderTypst — escaping', () => {
  it('escapes Typst markup special chars in body text', () => {
    const out = typ([para([text('a *b* #c $d$ [e] `f`')])])
    // The literal asterisks / hash / dollar / brackets / backtick must be escaped
    // so they render as text, not Typst syntax.
    expect(out).toContain('\\*b\\*')
    expect(out).toContain('\\#c')
    expect(out).toContain('\\$d\\$')
    expect(out).toContain('\\[e\\]')
    expect(out).toContain('\\`f\\`')
  })

  it('escapes double-quotes/backslashes in link href string literal', () => {
    const out = __test.wrapMark({ type: 'link', attrs: { href: 'https://x.com/"a\\b' } }, 't')
    expect(out).toBe('#link("https://x.com/\\"a\\\\b")[t]')
  })

  it('escapes title in preamble', () => {
    const out = renderTypst(doc([]), { title: 'He said "hi" \\ bye', attachments: new Map() })
    expect(out).toContain('#set document(title: "He said \\"hi\\" \\\\ bye")')
  })
})

// ── node coverage ────────────────────────────────────────────────────────────
describe('renderTypst — nodes', () => {
  it('renders headings by level', () => {
    expect(typ([{ type: 'heading', attrs: { level: 2 }, content: [text('H')] }])).toContain('== H')
  })

  it('renders bullet and ordered lists', () => {
    const b = typ([{ type: 'bulletList', content: [
      { type: 'listItem', content: [para([text('one')])] },
      { type: 'listItem', content: [para([text('two')])] },
    ] }])
    expect(b).toContain('#list(')
    expect(b).toContain('one')
    expect(b).toContain('two')
    const o = typ([{ type: 'orderedList', attrs: { start: 3 }, content: [
      { type: 'listItem', content: [para([text('x')])] },
    ] }])
    expect(o).toContain('#enum(')
    expect(o).toContain('start: 3')
  })

  it('renders task items with checkboxes', () => {
    const out = typ([{ type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: true }, content: [para([text('done')])] },
      { type: 'taskItem', attrs: { checked: false }, content: [para([text('todo')])] },
    ] }])
    expect(out).toContain('☑')
    expect(out).toContain('☐')
  })

  it('renders code blocks as fenced raw with sanitized language', () => {
    const out = typ([{ type: 'codeBlock', attrs: { language: 'js; rm -rf' }, content: [text('const x=1')] }])
    // Unsafe language dropped, fence still present with the code text.
    expect(out).toContain('```')
    expect(out).toContain('const x=1')
    expect(out).not.toContain('rm -rf')
  })

  it('renders tables with header cells bold and correct column count', () => {
    const out = typ([{ type: 'table', content: [
      { type: 'tableRow', content: [
        { type: 'tableHeader', content: [para([text('A')])] },
        { type: 'tableHeader', content: [para([text('B')])] },
      ] },
      { type: 'tableRow', content: [
        { type: 'tableCell', content: [para([text('1')])] },
        { type: 'tableCell', content: [para([text('2')])] },
      ] },
    ] }])
    expect(out).toContain('table.header(')
    expect(out).toContain('#text(weight: "bold")[A]')
  })

  it('renders callouts with variant fill', () => {
    const out = typ([{ type: 'callout', attrs: { variant: 'warn' }, content: [para([text('careful')])] }])
    expect(out).toContain('#block(fill: rgb("#fef3e6")')
    expect(out).toContain('careful')
  })

  it('renders block and inline math', () => {
    const out = typ([
      { type: 'blockMath', attrs: { latex: '\\frac{1}{2}' } },
      para([{ type: 'inlineMath', attrs: { latex: 'x^2' } }]),
    ])
    expect(out).toContain('$ frac(1, 2) $')
    expect(out).toContain('$x^2$')
  })

  it('resolves emoji shortcodes to glyphs', () => {
    const out = typ([para([{ type: 'emoji', attrs: { name: 'rocket' } }])])
    expect(out).toContain('🚀')
  })

  it('drops image nodes without a resolved local path', () => {
    const out = typ([{ type: 'image', attrs: { attachId: 'nope' } }])
    // No figure is emitted for an unresolved image (the preamble still defines
    // the __capImage helper, so we assert no #figure(__capImage(...)) call).
    expect(out).not.toContain('__capImage("')
    expect(out).not.toContain('#figure(')
  })

  it('clamps pathological table span attrs (DoS guard)', () => {
    const out = typ([{ type: 'table', content: [
      { type: 'tableRow', content: [
        { type: 'tableCell', attrs: { colspan: 1e9 }, content: [para([text('x')])] },
      ] },
    ] }])
    // colspan clamped to <=100, so the column count stays sane (<=100 `1fr`
    // tracks), never 1e9 tracks.
    const match = out.match(/columns: \(([^)]*)\)/)
    expect(match).not.toBeNull()
    const trackCount = match![1]!.split(',').length
    expect(trackCount).toBeLessThanOrEqual(100)
  })
})
