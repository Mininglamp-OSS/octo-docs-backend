import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { sanitizeSvg, InvalidSvgError, MAX_SANITIZED_SVG_BYTES } from '../src/util/sanitizeSvg.js'

const clean = (svg: string) => sanitizeSvg(Buffer.from(svg)).toString('utf8')

describe('sanitizeSvg', () => {
  it('preserves ordinary vector content', () => {
    const out = clean('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Logo</title><path d="M0 0h10v10z" fill="#123456"/></svg>')
    expect(out).toContain('<svg')
    expect(out).toContain('<path')
    expect(out).toContain('<title>Logo</title>')
    expect(out).toContain('fill="#123456"')
  })

  it('preserves safe presentation declarations from authoring-tool inline styles', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg" style="fill:#f4f1de">
      <rect width="10" height="10" style="fill:#e07a5f;stroke:#3d405b;stroke-width:2;opacity:.75;vector-effect:non-scaling-stroke"/>
      <text style="font-family:sans-serif;font-size:12px;font-weight:700;text-anchor:middle;letter-spacing:1px">A</text>
    </svg>`)

    expect(out).toMatch(/style="[^"]*fill: rgb\(244, 241, 222\)/)
    expect(out).toMatch(/style="[^"]*fill: rgb\(224, 122, 95\)/)
    expect(out).toMatch(/style="[^"]*stroke: rgb\(61, 64, 91\)/)
    expect(out).toMatch(/style="[^"]*stroke-width: 2/)
    expect(out).toMatch(/style="[^"]*opacity: 0\.75/)
    expect(out).toMatch(/style="[^"]*vector-effect: non-scaling-stroke/)
    expect(out).toMatch(/style="[^"]*font-family: sans-serif/)
    expect(out).toMatch(/style="[^"]*text-anchor: middle/)
  })

  it('removes scripts, events, foreignObject, stylesheets, and external URLs', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><style>@import url(https://evil.test/x)</style>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
      <image href="https://evil.test/pixel.png"/><use href="#safe"/>
      <a href="javascript:alert(1)"><path fill="url(https://evil.test/paint)"/></a>
    </svg>`)
    expect(out).not.toMatch(/script|foreignObject|onload|javascript:|https:\/\/evil|@import/i)
    expect(out).not.toContain('<use')
    expect(out).not.toContain('fill="url(')
  })

  it('preserves same-document gradient/filter references while stripping external CSS URLs', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g"><stop stop-color="red"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>
      <rect id="attrs" fill="url(#g)" filter="url('#f')"/>
      <rect class="style-local" style="fill:url(#g);stroke:url('#g')"/>
      <rect id="external" fill="url(https://evil.test/paint)" style="filter:u\\72l(https://evil.test/filter)"/>
    </svg>`)
    const dom = new JSDOM(out, { contentType: 'image/svg+xml' }).window.document
    expect(dom.getElementById('attrs')?.getAttribute('fill')).toBe('url(#g)')
    expect(dom.getElementById('attrs')?.getAttribute('filter')).toBe("url('#f')")
    const localStyle = dom.querySelector('.style-local')?.getAttribute('style')
    expect(localStyle).toMatch(/fill: url\(["']?#g["']?\)/)
    expect(localStyle).toMatch(/stroke: url\(["']?#g["']?\)/)
    expect(dom.getElementById('external')?.hasAttribute('fill')).toBe(false)
    expect(dom.getElementById('external')?.hasAttribute('style')).toBe(false)
    expect(out).not.toContain('evil.test')
  })

  it('keeps safe declarations while deleting disallowed CSS, and drops active CSS wholesale', () => {
    const out = clean(`<svg xmlns="http://www.w3.org/2000/svg">
      <path id="safe" style="fill:#e07a5f;stroke:#3d405b;position:fixed;background-image:none;--x:red"/>
      <path id="url" style="fill:red;stroke:url(https://evil.test/p)"/>
      <path id="escaped-url" style="fill:u\\72l(https://evil.test/p)"/>
      <path id="expression" style="opacity:1;fill:expre\\73 sion(alert(1))"/>
      <path id="import" style="@import 'https://evil.test/x';fill:blue"/>
    </svg>`)

    const dom = new JSDOM(out, { contentType: 'image/svg+xml' }).window.document
    const safe = dom.getElementById('safe')?.getAttribute('style') ?? ''
    expect(safe).toContain('fill: rgb(224, 122, 95)')
    expect(safe).toContain('stroke: rgb(61, 64, 91)')
    expect(safe).not.toMatch(/position|background|--x/)
    for (const id of ['url', 'escaped-url', 'expression', 'import']) {
      expect(dom.getElementById(id)?.hasAttribute('style')).toBe(false)
    }
    expect(out).not.toMatch(/url\s*\(|expression\s*\(|@import|evil\.test/i)
  })

  it('rejects oversized, overly complex, deeply nested, and invalid UTF-8 SVG before parsing', () => {
    const oversized = Buffer.alloc(MAX_SANITIZED_SVG_BYTES + 1, 0x20)
    expect(() => sanitizeSvg(oversized)).toThrow(/svg_too_large/)

    const manyElements = `<svg xmlns="http://www.w3.org/2000/svg">${'<g/>'.repeat(12_001)}</svg>`
    expect(() => clean(manyElements)).toThrow(/svg_too_complex/)

    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(129)}${'</g>'.repeat(129)}</svg>`
    expect(() => clean(deep)).toThrow(/svg_too_complex/)

    expect(() => sanitizeSvg(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow(InvalidSvgError)
  })

  it('rejects doctype/entity payloads and non-SVG documents', () => {
    expect(() => clean('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')).toThrow(InvalidSvgError)
    expect(() => clean('<html><body>x</body></html>')).toThrow(InvalidSvgError)
  })
})
