import { describe, it, expect } from 'vitest'
import { collectReferencedAttachIds, isSupportedImage } from '../src/api/routes/export.js'

// The PDF export must only download images the document actually references,
// never the full attachment list (a doc can carry orphaned/unreferenced
// uploads). collectReferencedAttachIds walks the ProseMirror JSON and returns
// exactly the attachIds embedded by `image` nodes — this is the correctness
// gate that bounds the image-prefetch DoS surface alongside the count/total
// byte caps in resolveInputs.
describe('collectReferencedAttachIds', () => {
  it('collects attachIds only from image nodes, nested at any depth', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { attachId: 'a1' } },
        {
          type: 'callout',
          content: [
            { type: 'paragraph', content: [{ type: 'image', attrs: { attachId: 'a2' } }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'no image here' }] },
      ],
    }
    const ids = collectReferencedAttachIds(doc)
    expect(ids).toEqual(new Set(['a1', 'a2']))
  })

  it('ignores non-image nodes and image nodes without an attachId', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { attachId: null } },
        { type: 'image', attrs: {} },
        { type: 'fileAttachment', attrs: { attachId: 'f1' } }, // not an image
        { type: 'image', attrs: { attachId: 'keep' } },
      ],
    }
    expect(collectReferencedAttachIds(doc)).toEqual(new Set(['keep']))
  })

  it('returns an empty set for empty / malformed input', () => {
    expect(collectReferencedAttachIds(null)).toEqual(new Set())
    expect(collectReferencedAttachIds({})).toEqual(new Set())
    expect(collectReferencedAttachIds({ type: 'doc' })).toEqual(new Set())
  })
})

// A corrupt or renamed non-image attachment would otherwise abort the entire
// typst compile (decode error -> HTTP 500). isSupportedImage sniffs the magic
// bytes so a bad upload is dropped like any other unresolved image.
describe('isSupportedImage', () => {
  const bytes = (...b: number[]) => Buffer.from([...b, ...new Array(Math.max(0, 12 - b.length)).fill(0)])
  it('accepts PNG/JPEG/GIF magic bytes', () => {
    expect(isSupportedImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBe(true) // PNG
    expect(isSupportedImage(bytes(0xff, 0xd8, 0xff))).toBe(true) // JPEG
    expect(isSupportedImage(bytes(0x47, 0x49, 0x46, 0x38))).toBe(true) // GIF
  })
  it('rejects non-image or truncated buffers', () => {
    expect(isSupportedImage(Buffer.from('not an image at all'))).toBe(false)
    expect(isSupportedImage(Buffer.from([0x89, 0x50]))).toBe(false) // too short
    expect(isSupportedImage(Buffer.alloc(0))).toBe(false)
  })

  it('rejects WebP and BMP (typst v0.13.1 cannot decode them)', () => {
    // A valid WebP/BMP would otherwise pass the sniff, get written into the
    // compile root, and abort the whole export with `unknown image format`.
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    const bmp = Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(isSupportedImage(webp)).toBe(false)
    expect(isSupportedImage(bmp)).toBe(false)
  })
})
