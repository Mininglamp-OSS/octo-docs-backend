/**
 * Schema-validation tests (大奔 review #1/#2/schema-兜底): the importer output
 * must be a VALID ProseMirror document under the editor schema — not just
 * structurally plausible JSON. These run the real buildSchema() +
 * Node.fromJSON().check(), which is what setContent / y-prosemirror do.
 *
 * Regression guards:
 *   #1 embedded images must NOT land in inline (paragraph) content — image is a
 *      block atom; a block atom inside inline content fails check().
 *   #2 a failed/absent image must degrade to a fileAttachment BLOCK, also valid.
 */
import { describe, it, expect } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema } from '../src/schema/index.js'
import { walkDocument } from '../src/import/docx/document.js'
import { resolveImages, imagePlaceholder, type MediaUploadCtx } from '../src/import/docx/media.js'
import { validateAgainstSchema } from '../src/import/docx/index.js'
import type { PmNode } from '../src/import/docx/types.js'

const schema = buildSchema()

/** Assert a doc passes the real ProseMirror schema check. */
function expectValid(doc: PmNode): void {
  expect(() => PMNode.fromJSON(schema, doc as never).check()).not.toThrow()
}

function docXml(inner: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0"?><w:document xmlns:w="http://x" xmlns:r="http://r"><w:body>${inner}</w:body></w:document>`,
    'utf8',
  )
}

describe('schema validity — walker output', () => {
  it('a paragraph with marks is valid', () => {
    const out = walkDocument(
      docXml('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>'),
      new Map(),
    )
    expectValid({ type: 'doc', content: out.content })
  })

  it('#1 an embedded image is a BLOCK sibling, keeping the doc valid', () => {
    // A paragraph containing a drawing: the image must NOT be inline.
    const inner =
      '<w:p><w:r><w:t>before</w:t></w:r>' +
      '<w:r><w:drawing><wp:inline xmlns:wp="http://wp"><wp:docPr descr="x"/>' +
      '<a:graphic xmlns:a="http://a"><a:blip r:embed="rId1"/></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>'
    const out = walkDocument(docXml(inner), new Map())
    // Strip the private _embedRel so the placeholder validates as a real image
    // (mirrors what the media step does when no upload ctx is present).
    for (const n of out.content) if (n.type === 'image' && n.attrs) delete (n.attrs as any)._embedRel
    expectValid({ type: 'doc', content: out.content })
    // And the image really is a top-level block, not inside the paragraph.
    expect(out.content.some((n) => n.type === 'image')).toBe(true)
    const para = out.content.find((n) => n.type === 'paragraph')
    expect(para?.content?.every((c) => c.type !== 'image')).toBe(true)
  })
})

describe('schema validity — image resolution', () => {
  const ctx: MediaUploadCtx = {
    docId: 'd',
    uid: 'u',
    maxImageBytes: 1024 * 1024,
    upload: async () => 'attach-1',
  }

  it('a resolved image node is valid', async () => {
    const doc: PmNode = { type: 'doc', content: [imagePlaceholder('rId1', 'alt')] }
    await resolveImages(
      doc,
      () => ({ name: 'word/media/i.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) }),
      ctx,
      [],
    )
    expect(doc.content![0]!.type).toBe('image')
    expectValid(doc)
  })

  it('#2 a degraded image is a valid fileAttachment block', async () => {
    const doc: PmNode = { type: 'doc', content: [imagePlaceholder('rId1', 'alt')] }
    await resolveImages(doc, () => null, ctx, []) // missing source → degrade
    expect(doc.content![0]!.type).toBe('fileAttachment')
    expectValid(doc)
  })
})

describe('validateAgainstSchema', () => {
  it('returns null for a valid doc', () => {
    expect(validateAgainstSchema({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBeNull()
  })

  it('returns an error message for an illegal doc (block atom in inline)', () => {
    const bad: PmNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { attachId: 'a' } }] }],
    }
    expect(validateAgainstSchema(bad)).not.toBeNull()
  })
})

describe('schema validity — code blocks & callouts', () => {
  it('a codeBlock + callout doc is schema-valid', () => {
    const inner =
      '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t>let x = 1</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="CalloutInfo"/></w:pPr><w:r><w:t>\u2139\ufe0f note</w:t></w:r></w:p>'
    const out = walkDocument(docXml(inner), new Map())
    expectValid({ type: 'doc', content: out.content })
    expect(out.content.map((n) => n.type)).toEqual(['codeBlock', 'callout'])
  })
})
