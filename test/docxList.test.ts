/**
 * Tests for list reconstruction (commit ③): flat OOXML list paragraphs →
 * nested ProseMirror lists. Covers the three failure modes red猫/大奔 flagged:
 * stack nesting, mixed ordered/bullet, and ilvl jumps — plus task lists.
 */
import { describe, it, expect } from 'vitest'
import { buildList, type ListLine } from '../src/import/docx/list.js'
import { parseNumbering } from '../src/import/docx/numbering.js'
import { walkDocument } from '../src/import/docx/document.js'

function line(ilvl: number, kind: ListLine['kind'], text: string, checked?: boolean): ListLine {
  return { ilvl, kind, checked, inline: [{ type: 'text', text }] }
}

/** Shorthand: item's first paragraph text. */
function itemText(item: { content?: Array<{ content?: Array<{ text?: string }> }> }): string {
  return item.content?.[0]?.content?.[0]?.text ?? ''
}

describe('buildList — flat & nested', () => {
  it('builds a flat bullet list', () => {
    const list = buildList([line(0, 'bullet', 'a'), line(0, 'bullet', 'b')])[0]!
    expect(list.type).toBe('bulletList')
    expect(list.content!.map((i) => itemText(i as never))).toEqual(['a', 'b'])
  })

  it('nests a child list under the last item (ilvl 0 → 1 → 0)', () => {
    const list = buildList([
      line(0, 'bullet', 'a'),
      line(1, 'bullet', 'a.1'),
      line(0, 'bullet', 'b'),
    ])[0]!
    // a has a nested bulletList; b is a sibling of a.
    const items = list.content!
    expect(items).toHaveLength(2)
    const nested = (items[0] as any).content[1]
    expect(nested.type).toBe('bulletList')
    expect(itemText(nested.content[0])).toBe('a.1')
    expect(itemText(items[1] as any)).toBe('b')
  })
})

describe('buildList — mixed ordered/bullet', () => {
  it('emits two sibling top-level lists when kind changes at the same level', () => {
    const roots = buildList([line(0, 'bullet', 'a'), line(0, 'ordered', '1')])
    expect(roots).toHaveLength(2)
    expect(roots[0]!.type).toBe('bulletList')
    expect(itemText(roots[0]!.content![0] as any)).toBe('a')
    expect(roots[1]!.type).toBe('orderedList')
    expect(itemText(roots[1]!.content![0] as any)).toBe('1')
  })

  it('nested list can be a different kind than its parent', () => {
    const list = buildList([
      line(0, 'bullet', 'a'),
      line(1, 'ordered', 'a.1'),
    ])[0]!
    const nested = (list.content![0] as any).content[1]
    expect(nested.type).toBe('orderedList')
    expect(itemText(nested.content[0])).toBe('a.1')
  })
})

describe('buildList — ilvl jumps', () => {
  it('synthesises intermediate levels on a 0 → 2 jump', () => {
    const list = buildList([line(0, 'bullet', 'a'), line(2, 'bullet', 'deep')])[0]!
    // a (level 0) → placeholder item holds a level-1 list → placeholder item
    // holds a level-2 list with "deep".
    const l1 = (list.content![0] as any).content[1]
    expect(l1.type).toBe('bulletList')
    const l2 = l1.content[0].content[1]
    expect(l2.type).toBe('bulletList')
    expect(itemText(l2.content[0])).toBe('deep')
  })

  it('starts directly at a deep level when the run opens with a jump', () => {
    const list = buildList([line(2, 'bullet', 'deep')])[0]!
    expect(list.type).toBe('bulletList') // root synthesised at level 0
    // Descend two placeholder levels to reach "deep".
    const l1 = (list.content![0] as any).content[1]
    const l2 = l1.content[0].content[1]
    expect(itemText(l2.content[0])).toBe('deep')
  })
})

describe('buildList — task lists', () => {
  it('builds a taskList with checked state', () => {
    const list = buildList([line(0, 'task', 'todo', false), line(0, 'task', 'done', true)])[0]!
    expect(list.type).toBe('taskList')
    expect(list.content!.map((i: any) => i.attrs.checked)).toEqual([false, true])
    expect(list.content!.map((i) => itemText(i as never))).toEqual(['todo', 'done'])
  })

  it('returns an empty array for an empty run', () => {
    expect(buildList([])).toEqual([])
  })
})

describe('parseNumbering', () => {
  const xml = Buffer.from(
    `<?xml version="1.0"?><w:numbering xmlns:w="http://x">
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
      </w:abstractNum>
      <w:abstractNum w:abstractNumId="1">
        <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
        <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="10"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="20"><w:abstractNumId w:val="1"/></w:num>
    </w:numbering>`,
    'utf8',
  )

  it('resolves numId → format kind through the abstractNum chain', () => {
    const n = parseNumbering(xml)
    expect(n.kindOf('10', 0)).toBe('bullet')
    expect(n.kindOf('20', 0)).toBe('ordered')
    expect(n.kindOf('20', 1)).toBe('ordered') // lowerLetter is ordered
  })

  it('defaults unknown numId / missing numbering to bullet', () => {
    expect(parseNumbering(undefined).kindOf('99', 0)).toBe('bullet')
    expect(parseNumbering(xml).kindOf('99', 0)).toBe('bullet')
  })

  it('reads an ordered list first number from w:start / w:startOverride', () => {
    // A list beginning at 20/41 must keep its numbering on import (not reset to
    // 1). w:start lives on the abstract level; w:startOverride on the instance.
    const startXml = Buffer.from(
      `<?xml version="1.0"?><w:numbering xmlns:w="http://x">
        <w:abstractNum w:abstractNumId="1">
          <w:lvl w:ilvl="0"><w:start w:val="20"/><w:numFmt w:val="decimal"/></w:lvl>
        </w:abstractNum>
        <w:abstractNum w:abstractNumId="2">
          <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
        </w:abstractNum>
        <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
        <w:num w:numId="3"><w:abstractNumId w:val="2"/>
          <w:lvlOverride w:ilvl="0"><w:startOverride w:val="41"/></w:lvlOverride>
        </w:num>
      </w:numbering>`,
      'utf8',
    )
    const n = parseNumbering(startXml)
    expect(n.startOf('2', 0)).toBe(20) // from the abstract level's w:start
    expect(n.startOf('3', 0)).toBe(41) // instance startOverride wins
    expect(n.startOf('99', 0)).toBe(1) // unknown → default 1
  })
})

describe('buildList — ordered list start', () => {
  const oline = (ilvl: number, text: string, start?: number): ListLine => ({
    ilvl,
    kind: 'ordered',
    inline: [{ type: 'text', text }],
    start,
  })

  it('sets orderedList.attrs.start from the first line when > 1', () => {
    const list = buildList([oline(0, 'x', 20), oline(0, 'y', 20)])[0]!
    expect(list.type).toBe('orderedList')
    expect(list.attrs?.start).toBe(20)
  })

  it('omits start for a default (1) ordered list', () => {
    const list = buildList([oline(0, 'x', 1), oline(0, 'y')])[0]!
    expect(list.attrs?.start).toBeUndefined()
  })
})

describe('walkDocument — list integration', () => {
  const numberingXml = Buffer.from(
    `<?xml version="1.0"?><w:numbering xmlns:w="http://x">
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    </w:numbering>`,
    'utf8',
  )
  const numbering = parseNumbering(numberingXml)

  function doc(inner: string): Buffer {
    return Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://x" xmlns:w14="http://14"><w:body>${inner}</w:body></w:document>`,
      'utf8',
    )
  }

  it('groups consecutive numbered paragraphs into one ordered list', () => {
    const inner =
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>after</w:t></w:r></w:p>'
    const out = walkDocument(doc(inner), new Map(), numbering)
    expect(out.content[0]!.type).toBe('orderedList')
    expect(out.content[0]!.content).toHaveLength(2)
    expect(out.content[1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'after' }] })
  })

  it('detects a task item from a w14:checkbox content control', () => {
    const inner =
      '<w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr></w:sdt>' +
      '<w:r><w:t>done</w:t></w:r></w:p>'
    const out = walkDocument(doc(inner), new Map(), numbering)
    expect(out.content[0]!.type).toBe('taskList')
    expect((out.content[0]!.content![0] as any).attrs.checked).toBe(true)
  })

  it('keeps a numbered paragraph that holds a formula as a list item, not a bare blockMath', () => {
    // Regression ("12345 都没了"): a numbered list item whose only content is a
    // display formula was routed to a standalone blockMath, dropping the list
    // and its number. It must stay an orderedList item with the math inline.
    const mdoc = (inner: string): Buffer =>
      Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://x" xmlns:w14="http://14" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${inner}</w:body></w:document>`,
        'utf8',
      )
    const mathRun =
      '<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>'
    const inner =
      `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${mathRun}</w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${mathRun}</w:p>`
    const out = walkDocument(mdoc(inner), new Map(), numbering)
    expect(out.content[0]!.type).toBe('orderedList')
    expect(out.content[0]!.content).toHaveLength(2)
    const para = (out.content[0]!.content![0] as any).content[0]
    expect(para.type).toBe('paragraph')
    expect(para.content[0].type).toBe('inlineMath')
    // No standalone blockMath leaked out of the list.
    expect(out.content.some((n: any) => n.type === 'blockMath')).toBe(false)
  })
})
