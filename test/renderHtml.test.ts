import { describe, it, expect } from 'vitest'
import { renderHtml } from '../src/export/renderHtml.js'

// Helpers to build minimal ProseMirror docs for the PDF-export HTML renderer.
const doc = (content: unknown[]) => ({ type: 'doc', content })
const para = (content: unknown[]) => ({ type: 'paragraph', content })
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const link = (href: string) => [{ type: 'link', attrs: { href } }]

function html(content: unknown[]): string {
  return renderHtml(doc(content), { title: 'T', attachments: new Map() })
}

describe('renderHtml — link href safety (isSafeHref)', () => {
  const safe = [
    'https://example.com',
    'http://x.com',
    'mailto:a@b.com',
    'tel:123',
    '/relative/path',
    '#anchor',
  ]
  for (const href of safe) {
    it(`keeps safe href: ${href}`, () => {
      const out = html([para([text('link', link(href))])])
      expect(out).toContain('<a href=')
      expect(out).toContain('link')
    })
  }

  const dangerous = [
    'javascript:alert(1)',
    'JavaScript:alert(1)', // case-insensitive
    'java\tscript:alert(1)', // control-char smuggling
    ' javascript:alert(1)', // leading whitespace
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox("x")',
  ]
  for (const href of dangerous) {
    it(`strips dangerous href to plain text: ${JSON.stringify(href)}`, () => {
      const out = html([para([text('link', link(href))])])
      expect(out).not.toContain('<a href=')
      // The text content is preserved (still selectable), just not linked.
      expect(out).toContain('link')
    })
  }
})

describe('renderHtml — paragraph leading spaces (white-space: pre-wrap)', () => {
  it('preserves leading spaces in a paragraph', () => {
    const out = html([para([text('   三个空格')])])
    expect(out).toContain('<p>   三个空格</p>')
  })

  it('preserves multiple interior spaces', () => {
    const out = html([para([text('中间   多个   空格')])])
    expect(out).toContain('中间   多个   空格')
  })

  it('declares white-space: pre-wrap on paragraphs', () => {
    const out = html([para([text('x')])])
    expect(out).toMatch(/p\s*\{[^}]*white-space:\s*pre-wrap/)
  })
})

describe('renderHtml — table column widths (tableColgroup + conditional fixed layout)', () => {
  const table = (cells: Array<{ colspan?: number; colwidth?: unknown }>) =>
    doc([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: cells.map((c) => ({
              type: 'tableCell',
              attrs: { colspan: c.colspan ?? 1, ...(c.colwidth !== undefined ? { colwidth: c.colwidth } : {}) },
              content: [para([text('x')])],
            })),
          },
        ],
      },
    ])

  const render = (d: unknown) => renderHtml(d, { title: 'T', attachments: new Map() })

  it('no colwidth → no colgroup / no has-colwidth class (even-width fixed layout)', () => {
    const out = render(table([{}, {}, {}]))
    expect(out).not.toContain('<table><colgroup>')
    expect(out).not.toContain('class="has-colwidth"')
    expect(out).toContain('<table><tbody>')
    // Every table uses fixed layout (matches the editor's .octo-prose table).
    expect(out).toMatch(/table\s*\{[^}]*table-layout:\s*fixed/)
  })

  it('explicit positive widths → colgroup + has-colwidth (fixed layout)', () => {
    const out = render(table([{ colwidth: [120] }, { colwidth: [300] }]))
    expect(out).toContain('class="has-colwidth"')
    expect(out).toContain('<colgroup><col')
    expect(out).toContain('width:120px')
    expect(out).toContain('width:300px')
  })

  it('boundary: colwidth of 0 is NOT treated as an explicit width', () => {
    const out = render(table([{ colwidth: [0] }, { colwidth: [0] }]))
    expect(out).not.toContain('<table><colgroup>')
    expect(out).not.toContain('class="has-colwidth"')
  })

  it('boundary: negative / NaN colwidth is ignored', () => {
    const out = render(table([{ colwidth: [-50] }, { colwidth: [Number.NaN] }]))
    expect(out).not.toContain('<table><colgroup>')
    expect(out).not.toContain('class="has-colwidth"')
  })

  it('mixed: some columns set, others null → colgroup with auto cols for the unset', () => {
    const out = render(table([{ colwidth: [120] }, { colwidth: [null] }]))
    expect(out).toContain('class="has-colwidth"')
    expect(out).toContain('width:120px')
    // The unset column emits a bare <col /> (auto).
    expect(out).toMatch(/<col \/>/)
  })
})

describe('renderHtml — table header repeats across pages (thead)', () => {
  const headerTable = doc([
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: {}, content: [para([text('H1')])] },
            { type: 'tableHeader', attrs: {}, content: [para([text('H2')])] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: {}, content: [para([text('a')])] },
            { type: 'tableCell', attrs: {}, content: [para([text('b')])] },
          ],
        },
      ],
    },
  ])
  const bodyOnlyTable = doc([
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: {}, content: [para([text('a')])] },
            { type: 'tableCell', attrs: {}, content: [para([text('b')])] },
          ],
        },
      ],
    },
  ])
  const render = (d: unknown) => renderHtml(d, { title: 'T', attachments: new Map() })

  it('a header-row table puts the header in <thead> and data in <tbody>', () => {
    const out = render(headerTable)
    expect(out).toMatch(/<thead><tr><th><p>H1<\/p><\/th><th><p>H2<\/p><\/th><\/tr><\/thead>/)
    expect(out).toContain('<tbody><tr><td><p>a</p>')
  })

  it('declares thead as table-header-group so it repeats per page', () => {
    const out = render(headerTable)
    expect(out).toMatch(/thead\s*\{[^}]*display:\s*table-header-group/)
  })

  it('a table with no header row emits no <thead>', () => {
    const out = render(bodyOnlyTable)
    expect(out).toContain('<table><tbody>')
    expect(out).not.toContain('<thead>')
  })
})

describe('renderHtml — emoji resolution (gitHubEmojis parity with the editor)', () => {
  const emojiDoc = (name: string) => doc([para([{ type: 'emoji', attrs: { name } }])])
  const render = (name: string) => renderHtml(emojiDoc(name), { title: 'T', attachments: new Map() })

  it('resolves a name that node-emoji lacked (vomiting_face → 🤮)', () => {
    const out = render('vomiting_face')
    expect(out).toContain('🤮')
    expect(out).not.toContain(':vomiting_face:')
  })

  it('resolves common emoji (smile)', () => {
    const out = render('smile')
    expect(out).toMatch(/<span class="emoji">.+<\/span>/)
    expect(out).not.toContain(':smile:')
  })

  it('unknown name falls back to :name: text', () => {
    const out = render('definitely_not_an_emoji_xyz')
    expect(out).toContain(':definitely_not_an_emoji_xyz:')
  })
})

describe('renderHtml — image src only from resolved attachments', () => {
  // Images now ONLY render from backend-resolved attachment URLs (attachId).
  // Raw attrs.src is never used, regardless of scheme safety.
  const attachments = new Map<string, { url: string; fileName: string; mime: string; sizeBytes: number }>([
    ['att1', { url: 'https://store.example.com/signed/key1', fileName: 'x.png', mime: 'image/png', sizeBytes: 100 }],
  ])

  it('renders <img> for resolved attachId', () => {
    const out = renderHtml(doc([{ type: 'image', attrs: { attachId: 'att1', alt: 'a' } }]), { title: 'T', attachments })
    expect(out).toContain('<img src="https://store.example.com/signed/key1"')
  })

  it('drops image with unknown attachId', () => {
    const out = renderHtml(doc([{ type: 'image', attrs: { attachId: 'unknown' } }]), { title: 'T', attachments })
    expect(out).not.toContain('<img')
  })

  it('drops image with raw src even if safe scheme', () => {
    const out = renderHtml(doc([{ type: 'image', attrs: { src: 'https://cdn.example.com/x.png' } }]), { title: 'T', attachments })
    expect(out).not.toContain('<img')
  })

  it('drops image with dangerous src', () => {
    const out = renderHtml(doc([{ type: 'image', attrs: { src: 'javascript:alert(1)' } }]), { title: 'T', attachments })
    expect(out).not.toContain('<img')
  })
})

describe('renderHtml — CSS value safety (highlight / textStyle whitelists)', () => {
  const hl = (color: string) => [{ type: 'highlight', attrs: { color } }]
  const ts = (attrs: Record<string, unknown>) => [{ type: 'textStyle', attrs }]

  it('keeps a safe highlight color', () => {
    const out = html([para([text('x', hl('#ff0'))])])
    expect(out).toContain('background-color:#ff0')
  })

  it('keeps rgb() highlight color', () => {
    const out = html([para([text('x', hl('rgb(255,0,0)'))])])
    expect(out).toContain('background-color:rgb(255,0,0)')
  })

  it('drops highlight color that smuggles extra CSS declarations', () => {
    const out = html([para([text('x', hl('red;position:fixed;top:0'))])])
    expect(out).not.toContain('position:fixed')
    // Falls back to a plain <mark> with no style attribute.
    expect(out).toContain('<mark>')
  })

  it('keeps safe textStyle color + fontSize', () => {
    const out = html([para([text('x', ts({ color: '#333', fontSize: '14px' }))])])
    expect(out).toContain('color:#333')
    expect(out).toContain('font-size:14px')
  })

  it('drops textStyle color/fontSize that inject extra CSS', () => {
    const out = html([para([text('x', ts({ color: 'red;background:url(x)', fontSize: '14px;z-index:9' }))])])
    expect(out).not.toContain('background:url')
    expect(out).not.toContain('z-index')
  })
})

describe('renderHtml — numeric attr clamping (DoS prevention)', () => {
  const table = (rows: unknown[]) => ({
    type: 'table',
    content: rows.map((cells) => ({
      type: 'tableRow',
      content: (cells as unknown[]).map((c: { attrs?: Record<string, unknown>; text?: string }) => ({
        type: 'tableCell',
        attrs: c.attrs ?? {},
        content: [para([text(c.text ?? '')])],
      })),
    })),
  })

  it('clamps huge colspan to 100', () => {
    const out = html([table([[{ attrs: { colspan: 1e8 }, text: 'x' }]])])
    // Should not hang or OOM; colspan capped at 100.
    expect(out).toContain('colspan="100"')
    expect(out).not.toContain('colspan="100000000"')
  })

  it('clamps huge rowspan to 100', () => {
    const out = html([table([[{ attrs: { rowspan: 999999 }, text: 'x' }]])])
    expect(out).toContain('rowspan="100"')
  })

  it('treats non-numeric colspan as 1', () => {
    const out = html([table([[{ attrs: { colspan: 'abc' }, text: 'x' }]])])
    expect(out).not.toContain('colspan=')
  })

  it('blocks CSS injection via image width', () => {
    const attachments = new Map([['att1', { url: 'https://store.example.com/x.png', fileName: 'x.png', mime: 'image/png', sizeBytes: 100 }]])
    const img = { type: 'image', attrs: { attachId: 'att1', width: '100px;position:fixed' } }
    const out = renderHtml(doc([img]), { title: 'T', attachments })
    expect(out).not.toContain('position:fixed')
  })

  it('allows safe image width values', () => {
    const attachments = new Map([['att1', { url: 'https://store.example.com/x.png', fileName: 'x.png', mime: 'image/png', sizeBytes: 100 }]])
    const img = { type: 'image', attrs: { attachId: 'att1', width: '300px' } }
    const out = renderHtml(doc([img]), { title: 'T', attachments })
    expect(out).toContain('width:300px')
  })
})
