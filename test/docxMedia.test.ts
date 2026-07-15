/**
 * Tests for embedded-image handling (commit ⑥): drawing → image placeholder,
 * magic-byte sniffing, upload → attachId, and the degradation paths (missing /
 * too large / unrecognised / upload failure never sink the import).
 */
import { describe, it, expect } from 'vitest'
import { sniffImageMime, resolveImages, imagePlaceholder, type MediaUploadCtx, type MediaResolver } from '../src/import/docx/media.js'
import type { ExtractedEntry } from '../src/import/docx/extract.js'
import { walkDocument } from '../src/import/docx/document.js'
import type { PmNode } from '../src/import/docx/types.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

describe('sniffImageMime', () => {
  it('detects png / jpeg / gif by magic number, not extension', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('GIF89a....'))).toBe('image/gif')
  })
  it('returns null for non-image bytes', () => {
    expect(sniffImageMime(Buffer.from('<html>'))).toBeNull()
  })
})

function ctx(overrides: Partial<MediaUploadCtx> = {}): MediaUploadCtx {
  return {
    docId: 'doc1',
    uid: 'u1',
    maxImageBytes: 10 * 1024 * 1024,
    upload: async () => 'attach-xyz',
    ...overrides,
  }
}

function media(name: string, data: Buffer): ExtractedEntry {
  return { name, data }
}

describe('resolveImages — success', () => {
  it('replaces an image placeholder with a real attachId node', async () => {
    const doc: PmNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [imagePlaceholder('rId5', 'a cat')] }],
    }
    const resolve = (rel: string) => (rel === 'rId5' ? media('word/media/image1.png', PNG) : null)
    const warnings: string[] = []
    await resolveImages(doc, resolve, ctx(), warnings)
    expect(doc.content![0]!.content![0]).toEqual({ type: 'image', attrs: { attachId: 'attach-xyz', alt: 'a cat' } })
    expect(warnings).toHaveLength(0)
  })

  it('passes the sniffed mime + filename to upload', async () => {
    const doc: PmNode = { type: 'doc', content: [imagePlaceholder('rId1', null)] }
    let received: { bytes: Buffer; mime: string; fileName: string } | undefined
    const resolve = () => media('word/media/photo.jpg', JPEG)
    await resolveImages(doc, resolve, ctx({ upload: async (i) => { received = i; return 'aid' } }), [])
    expect(received!.mime).toBe('image/jpeg')
    expect(received!.fileName).toBe('photo.jpg')
  })
})

describe('resolveImages — degradation (never sinks the import)', () => {
  async function degradeReason(resolve: MediaResolver, c = ctx()): Promise<string[]> {
    const doc: PmNode = { type: 'doc', content: [imagePlaceholder('rId1', null)] }
    const warnings: string[] = []
    await resolveImages(doc, resolve, c, warnings)
    // Degraded node is a fileAttachment block atom, not an image.
    expect(doc.content![0]!.type).toBe('fileAttachment')
    return warnings
  }

  it('degrades a missing media source', async () => {
    const w = await degradeReason(() => null)
    expect(w.join(' ')).toMatch(/source missing/)
  })
  it('degrades an oversized image', async () => {
    const w = await degradeReason(() => media('word/media/x.png', PNG), ctx({ maxImageBytes: 4 }))
    expect(w.join(' ')).toMatch(/too large/)
  })
  it('degrades an unrecognised format', async () => {
    const w = await degradeReason(() => media('word/media/x.bin', Buffer.from('not an image')))
    expect(w.join(' ')).toMatch(/unrecognised/)
  })
  it('degrades on upload failure', async () => {
    const w = await degradeReason(
      () => media('word/media/x.png', PNG),
      ctx({ upload: async () => { throw new Error('s3 down') } }),
    )
    expect(w.join(' ')).toMatch(/upload failed/)
  })
})

describe('walkDocument — drawing detection', () => {
  it('emits an image placeholder from a w:drawing a:blip r:embed', () => {
    const inner =
      '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://wp">' +
      '<wp:docPr descr="my chart"/>' +
      '<a:graphic xmlns:a="http://a"><a:graphicData><pic:pic xmlns:pic="http://pic">' +
      '<pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>' +
      '</wp:inline></w:drawing></w:r></w:p>'
    const xml = Buffer.from(
      `<?xml version="1.0"?><w:document xmlns:w="http://x" xmlns:r="http://r"><w:body>${inner}</w:body></w:document>`,
      'utf8',
    )
    const out = walkDocument(xml, new Map())
    // The image is a BLOCK sibling (schema: image is block/atom), not inline in
    // the paragraph. The empty paragraph is dropped since it has an image block.
    const img = out.content.find((n) => n.type === 'image')!
    expect(img).toBeDefined()
    expect((img.attrs as Record<string, unknown>)._embedRel).toBe('rId7')
    expect((img.attrs as Record<string, unknown>).alt).toBe('my chart')
  })
})
