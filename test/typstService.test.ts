import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { renderTypst } from '../src/export/renderTypst.js'
import { compileTypst } from '../src/export/typstService.js'

// The typst binary may not be present in every CI image; probe once and skip the
// real-compile suite when it's missing (the pure-transform tests in
// renderTypst.test.ts still run everywhere).
function typstAvailable(): boolean {
  try {
    execFileSync(process.env.TYPST_EXPORT_BINARY || 'typst', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HAS_TYPST = typstAvailable()
const d = HAS_TYPST ? describe : describe.skip

const doc = (content: unknown[]) => ({ type: 'doc', content })
const para = (content: unknown[]) => ({ type: 'paragraph', content })
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })

d('typstService — real compile (integration)', () => {
  it('embeds a sanitized SVG image in the compiled PDF', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#e11d48"/><circle cx="40" cy="20" r="12" fill="white"/></svg>')
    const src = renderTypst(
      doc([{ type: 'image', attrs: { attachId: 'svg-1', width: '80px' } }]),
      {
        title: 'SVG image',
        attachments: new Map([['svg-1', { url: '', fileName: 'shape.svg', mime: 'image/svg+xml', sizeBytes: svg.length }]]),
        imagePaths: new Map([['svg-1', 'img_0.svg']]),
      },
    )
    expect(src).toContain('__capImage("img_0.svg"')
    const pdf = await compileTypst(src, [{ fileName: 'img_0.svg', bytes: svg }])
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  })

  it('compiles a rich CJK + math + table + code document to a valid PDF', async () => {
    const src = renderTypst(
      doc([
        { type: 'heading', attrs: { level: 2 }, content: [text('章节 Section')] },
        para([
          text('中文正文，含 '),
          text('粗体', [{ type: 'bold' }]),
          text(' 与 '),
          text('斜体', [{ type: 'italic' }]),
          text(' 及链接 '),
          text('Octo', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        ]),
        { type: 'blockMath', attrs: { latex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}' } },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [para([text('第一项')])] },
          { type: 'listItem', content: [para([text('第二项')])] },
        ] },
        { type: 'callout', attrs: { variant: 'warn' }, content: [para([text('注意事项')])] },
        { type: 'table', content: [
          { type: 'tableRow', content: [
            { type: 'tableHeader', content: [para([text('列A')])] },
            { type: 'tableHeader', content: [para([text('列B')])] },
          ] },
          { type: 'tableRow', content: [
            { type: 'tableCell', content: [para([text('数据1')])] },
            { type: 'tableCell', content: [para([text('数据2')])] },
          ] },
        ] },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [text('const x = 1\nconsole.log(x)')] },
      ]),
      { title: '测试文档', attachments: new Map() },
    )

    const pdf = await compileTypst(src)
    // Valid PDF magic header + non-trivial size.
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  })

  it('never emits a document that fails to compile for exotic math (fallback path)', async () => {
    const src = renderTypst(
      doc([{ type: 'blockMath', attrs: { latex: '\\weirdunknownmacro{\\foo}_{\\bar}^{42}' } }]),
      { title: 't', attachments: new Map() },
    )
    const pdf = await compileTypst(src)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('compiles CJK text styled with mapped CJK fonts (embedded OSS faces resolve)', async () => {
    // Regression for octo-docs-backend#62: a document whose text picks CJK fonts
    // (宋体 -> serif, 微软雅黑 -> sans) must map to the embedded OSS families and
    // compile cleanly against the runtime font book (no missing-font failure,
    // no silent fallback). The source is asserted to carry the mapped families.
    const src = renderTypst(
      doc([
        para([text('宋体正文', [{ type: 'textStyle', attrs: { fontFamily: '宋体' } }])]),
        para([text('黑体标题', [{ type: 'textStyle', attrs: { fontFamily: '微软雅黑' } }])]),
      ]),
      { title: '字体测试', attachments: new Map() },
    )
    expect(src).toContain('font: "Noto Serif CJK SC"')
    expect(src).toContain('font: "Noto Sans CJK SC"')
    const pdf = await compileTypst(src)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  })
})
