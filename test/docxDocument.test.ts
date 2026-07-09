/**
 * Tests for the document.xml body walker (commit ②) + the full parse pipeline.
 *
 * We feed real OOXML fragments (paragraphs, headings, runs with rPr toggles,
 * hyperlinks) through buildDocFromParts / walkDocument and assert the emitted
 * ProseMirror JSON.
 */
import { describe, it, expect } from 'vitest'
import { walkDocument, type RelMap } from '../src/import/docx/document.js'
import { buildDocFromParts } from '../src/import/docx/index.js'
import type { ExtractedDocx, ExtractedEntry } from '../src/import/docx/extract.js'

function buf(xml: string): Buffer {
  return Buffer.from(xml, 'utf8')
}

/** Wrap body XML in a document.xml envelope. */
function docXml(bodyInner: string): Buffer {
  return buf(
    `<?xml version="1.0"?><w:document xmlns:w="http://x" xmlns:r="http://r"><w:body>${bodyInner}</w:body></w:document>`,
  )
}

function extracted(parts: Record<string, Buffer>): ExtractedDocx {
  const map = new Map<string, ExtractedEntry>()
  for (const [name, data] of Object.entries(parts)) map.set(name, { name, data })
  return { parts: map, media: [], warnings: [] }
}

describe('walkDocument — paragraphs & headings', () => {
  it('maps a plain paragraph', () => {
    const out = walkDocument(docXml('<w:p><w:r><w:t>hello</w:t></w:r></w:p>'), new Map())
    expect(out.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('maps Heading2 pStyle to a level-2 heading', () => {
    const xml = docXml('<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>')
    const out = walkDocument(xml, new Map())
    expect(out.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Title' }],
    })
  })

  it('reads paragraph alignment', () => {
    const xml = docXml('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>c</w:t></w:r></w:p>')
    const out = walkDocument(xml, new Map())
    expect(out.content[0]!.attrs).toEqual({ textAlign: 'center' })
  })

  it('emits an empty paragraph for an empty body', () => {
    const out = walkDocument(docXml(''), new Map())
    expect(out.content).toEqual([{ type: 'paragraph', content: [] }])
  })
})

describe('walkDocument — run marks', () => {
  it('maps bold/italic/underline/strike toggles', () => {
    const rPr = '<w:rPr><w:b/><w:i/><w:u w:val="single"/><w:strike/></w:rPr>'
    const xml = docXml(`<w:p><w:r>${rPr}<w:t>x</w:t></w:r></w:p>`)
    const marks = walkDocument(xml, new Map()).content[0]!.content![0]!.marks!.map((m) => m.type)
    expect(marks).toEqual(['bold', 'italic', 'underline', 'strike'])
  })

  it('respects an explicit w:b val="0" (off)', () => {
    const xml = docXml('<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>x</w:t></w:r></w:p>')
    const node = walkDocument(xml, new Map()).content[0]!.content![0]!
    expect(node.marks).toBeUndefined()
  })

  it('maps superscript / subscript vertAlign', () => {
    const sup = docXml('<w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r></w:p>')
    const sub = docXml('<w:p><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>i</w:t></w:r></w:p>')
    expect(walkDocument(sup, new Map()).content[0]!.content![0]!.marks![0]!.type).toBe('superscript')
    expect(walkDocument(sub, new Map()).content[0]!.content![0]!.marks![0]!.type).toBe('subscript')
  })

  it('maps a hex color to a textStyle mark and rejects "auto"', () => {
    const ok = docXml('<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>r</w:t></w:r></w:p>')
    const auto = docXml('<w:p><w:r><w:rPr><w:color w:val="auto"/></w:rPr><w:t>a</w:t></w:r></w:p>')
    expect(walkDocument(ok, new Map()).content[0]!.content![0]!.marks![0]).toEqual({
      type: 'textStyle',
      attrs: { color: '#ff0000' },
    })
    expect(walkDocument(auto, new Map()).content[0]!.content![0]!.marks).toBeUndefined()
  })

  it('emits a hardBreak for w:br and a tab for w:tab', () => {
    const xml = docXml('<w:p><w:r><w:t>a</w:t><w:br/><w:tab/></w:r></w:p>')
    const kinds = walkDocument(xml, new Map()).content[0]!.content!.map((n) => n.type + (n.text ?? ''))
    expect(kinds).toEqual(['texta', 'hardBreak', 'text\t'])
  })
})

describe('walkDocument — hyperlinks', () => {
  it('maps an external hyperlink via rels to a link mark', () => {
    const rels: RelMap = new Map([['rId1', 'https://example.com']])
    const xml = docXml('<w:p><w:hyperlink r:id="rId1"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>')
    const node = walkDocument(xml, rels).content[0]!.content![0]!
    expect(node).toEqual({ type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] })
  })

  it('drops a javascript: hyperlink href but keeps the text', () => {
    const rels: RelMap = new Map([['rId1', 'javascript:alert(1)']])
    const xml = docXml('<w:p><w:hyperlink r:id="rId1"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>')
    const node = walkDocument(xml, rels).content[0]!.content![0]!
    expect(node).toEqual({ type: 'text', text: 'x' })
  })
})

describe('walkDocument — code blocks & callouts (styled paragraphs)', () => {
  it('coalesces consecutive CodeBlock paragraphs into one codeBlock node', () => {
    const xml = docXml(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t>const a = 1</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t>const b = 2</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    expect(out.content).toEqual([
      {
        type: 'codeBlock',
        attrs: { language: null },
        content: [{ type: 'text', text: 'const a = 1\nconst b = 2' }],
      },
    ])
  })

  it('maps a CalloutWarn run to a callout node and strips the leading icon', () => {
    const xml = docXml(
      '<w:p><w:pPr><w:pStyle w:val="CalloutWarn"/></w:pPr>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>\u26a0\ufe0f warning body</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="CalloutWarn"/></w:pPr><w:r><w:t>second line</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    expect(out.content).toHaveLength(1)
    const callout = out.content[0]
    expect(callout.type).toBe('callout')
    expect(callout.attrs).toEqual({ variant: 'warn' })
    expect(callout.content).toHaveLength(2)
    // First line: icon glyph stripped, body preserved with its bold mark.
    const firstText = callout.content?.[0]?.content?.[0]
    expect(firstText?.text).toBe('warning body')
    expect(firstText?.marks).toEqual([{ type: 'bold' }])
    expect(callout.content?.[1]?.content?.[0]?.text).toBe('second line')
  })

  it('separates callouts of different variants into distinct nodes', () => {
    const xml = docXml(
      '<w:p><w:pPr><w:pStyle w:val="CalloutInfo"/></w:pPr><w:r><w:t>\u2139\ufe0f info</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="CalloutTip"/></w:pPr><w:r><w:t>\ud83d\udca1 tip</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    expect(out.content.map((n) => [n.type, n.attrs?.variant])).toEqual([
      ['callout', 'info'],
      ['callout', 'tip'],
    ])
  })

  it('decodes XML entities in code block text (quotes/angles/amp)', () => {
    const xml = docXml(
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>' +
        '<w:r><w:t>console.log(&quot;a &amp; b&quot; &lt; c)</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    expect(out.content[0]?.content?.[0]?.text).toBe('console.log("a & b" < c)')
  })

  it('drops the empty leading bold run + icon on a callout first line', () => {
    // Exporter emits iconPrefix as an (often empty) bold run before the glyph.
    const xml = docXml(
      '<w:p><w:pPr><w:pStyle w:val="CalloutInfo"/></w:pPr>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t> </w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>\u2139\ufe0f </w:t></w:r>' +
        '<w:r><w:t>note body</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    const firstText = out.content[0]?.content?.[0]?.content?.[0]
    expect(firstText?.text).toBe('note body')
  })

  it('drops a bold spacer run that FOLLOWS the icon glyph run', () => {
    // Real exporter order: [emoji glyph run][bold space run][body run]. After
    // the glyph run collapses to empty, the trailing bold-space run must not
    // survive as a leading space on the callout body.
    const xml = docXml(
      '<w:p><w:pPr><w:pStyle w:val="CalloutInfo"/></w:pPr>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t>\u2139\ufe0f</w:t></w:r>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t> </w:t></w:r>' +
        '<w:r><w:t>info body</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    const content = out.content[0]?.content?.[0]?.content
    expect(content?.[0]?.text).toBe('info body')
    // No leading whitespace-only node survived.
    expect(content?.some((n) => n.type === 'text' && (n.text ?? '').trim() === '')).toBe(false)
  })
})

describe('walkDocument — entity decoding in plain text', () => {
  it('decodes entities and numeric refs in a paragraph run', () => {
    const xml = docXml('<w:p><w:r><w:t>a &lt; b &amp;&amp; c &#65;</w:t></w:r></w:p>')
    const out = walkDocument(xml, new Map())
    expect(out.content[0]?.content?.[0]?.text).toBe('a < b && c A')
  })
})

describe('walkDocument — run font size & colour (textStyle)', () => {
  it('reads w:sz (half-points) back to the editor px value', () => {
    // Exporter writes parseFloat("18px")*2 = 36 half-points; reverse => "18px".
    const xml = docXml('<w:p><w:r><w:rPr><w:sz w:val="36"/></w:rPr><w:t>big</w:t></w:r></w:p>')
    const out = walkDocument(xml, new Map())
    expect(out.content[0]?.content?.[0]?.marks).toEqual([
      { type: 'textStyle', attrs: { fontSize: '18px' } },
    ])
  })

  it('combines colour and font size onto one textStyle mark', () => {
    const xml = docXml(
      '<w:p><w:r><w:rPr><w:color w:val="FF0000"/><w:sz w:val="24"/></w:rPr><w:t>x</w:t></w:r></w:p>',
    )
    const out = walkDocument(xml, new Map())
    expect(out.content[0]?.content?.[0]?.marks).toEqual([
      { type: 'textStyle', attrs: { color: '#ff0000', fontSize: '12px' } },
    ])
  })
})

describe('buildDocFromParts — pipeline', () => {
  it('assembles a doc from document.xml + rels parts', () => {
    const out = buildDocFromParts(
      extracted({
        'word/document.xml': docXml('<w:p><w:r><w:t>hi</w:t></w:r></w:p>'),
        'word/_rels/document.xml.rels': buf(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="https://a.b"/></Relationships>',
        ),
      }),
    )
    expect(out.doc).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })
  })

  it('degrades to an empty doc when document.xml is absent', () => {
    const out = buildDocFromParts(extracted({}))
    expect(out.doc.content).toEqual([{ type: 'paragraph', content: [] }])
  })
})
