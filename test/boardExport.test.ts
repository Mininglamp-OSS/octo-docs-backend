import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

// Offline unit test for W3 — server-side whiteboard image export.
//
// Two layers are covered:
//   1. serializeSceneToSvg / rasterizeSvgToPng — the pure renderer (no I/O).
//   2. exportBoardHandler — the route, with the guard + live-read + attachment
//      boundaries mocked so it runs without a collab server or database
//      (mirrors boardVersionSnapshot.test.ts / docSheet's offline handler tests).

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))
vi.mock('../src/db/pool.js', () => ({ query: vi.fn(async () => []), transaction: vi.fn() }))

const { live } = vi.hoisted(() => ({ live: { state: new Uint8Array([0, 0]) } }))
vi.mock('../src/collab/liveDocRead.js', () => ({
  readLiveDocState: vi.fn(async () => live.state),
}))
// No images in these scenes → listByDoc returns []; objectStore/fetch untouched.
vi.mock('../src/db/repos/docAttachmentRepo.js', () => ({
  docAttachmentRepo: { listByDoc: vi.fn(async () => []), getById: vi.fn(async () => null) },
}))

import { serializeSceneToSvg, computeSceneLayout, rasterizeSvgToPng } from '../src/whiteboard/exportScene.js'
import { exportBoardHandler } from '../src/api/routes/boardExport.js'
import { requireDocRole } from '../src/api/guard.js'
import { COLLAB_FIELD } from '../src/schema/index.js'

// ── scene builders (same shape as boardVersionSnapshot.test.ts) ──────────────

function el(id: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type, index: 'a0', x: 0, y: 0, width: 100, height: 50, isDeleted: false, ...extra }
}

function liveBoard(
  elements: Array<Record<string, unknown>>,
  files: Record<string, Record<string, unknown>> = {},
): Uint8Array {
  const doc = new Y.Doc()
  const elMap = doc.getMap('elements')
  const fMap = doc.getMap('files')
  doc.transact(() => {
    for (const e of elements) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(e)) y.set(k, v)
      elMap.set(e.id as string, y)
    }
    for (const [fid, f] of Object.entries(files)) {
      const y = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(f)) y.set(k, v)
      fMap.set(fid, y)
    }
  })
  return Y.encodeStateAsUpdate(doc)
}

const boardGuard = {
  meta: { doc_id: 'b_1', document_name: 'octo:s1:f_default:wb:b_1', doc_type: 'board' },
  role: 'reader',
} as never
const docGuard = {
  meta: { doc_id: 'd_1', document_name: 'octo:s1:f_default:d_1', doc_type: 'doc' },
  role: 'reader',
} as never

interface MockRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  contentType: string
  status(c: number): MockRes
  json(b: unknown): MockRes
  send(b: unknown): MockRes
  type(t: string): MockRes
  setHeader(k: string, v: string): void
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    contentType: '',
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
    send(b) {
      this.body = b
      return this
    },
    type(t) {
      this.contentType = t
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
  }
}
function req(params: Record<string, string>, query: Record<string, unknown> = {}) {
  return { uid: 'u_1', spaceId: 's1', params, query } as never
}

describe('serializeSceneToSvg', () => {
  it('emits a valid standalone SVG for a mixed scene', () => {
    const svg = serializeSceneToSvg({
      elements: [
        el('r1', 'rectangle', { strokeColor: '#e03131', backgroundColor: '#ffc9c9', roundness: { type: 3 } }),
        el('e1', 'ellipse', { x: 200 }),
        el('d1', 'diamond', { x: 400 }),
        el('a1', 'arrow', { x: 0, y: 200, points: [[0, 0], [120, 40]] }),
        el('l1', 'line', { x: 0, y: 300, points: [[0, 0], [80, 0], [80, 40]] }),
        el('t1', 'text', { x: 0, y: 400, text: 'Hello & <world>', fontSize: 24 }),
      ],
      files: {},
    })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('</svg>')
    expect(svg).toContain('<rect')
    expect(svg).toContain('<ellipse')
    expect(svg).toContain('<polygon') // diamond + arrowhead
    expect(svg).toContain('<polyline')
    expect(svg).toContain('<text')
    expect(svg).toContain('#e03131')
    // Text content is XML-escaped, never injected raw.
    expect(svg).toContain('Hello &amp; &lt;world&gt;')
    expect(svg).not.toContain('<world>')
  })

  it('renders an empty scene as a small blank white canvas (valid, openable)', () => {
    const svg = serializeSceneToSvg({ elements: [], files: {} })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('width="100"')
  })

  it('renders a placeholder for an image element whose bytes were not resolved', () => {
    const svg = serializeSceneToSvg(
      { elements: [el('i1', 'image', { fileId: 'f1' })], files: { f1: { attachId: 'att1' } } },
      new Map(),
    )
    expect(svg).toContain('stroke-dasharray="4 4"') // placeholder rect
    expect(svg).not.toContain('<image')
  })

  it('embeds resolved image bytes as a data URI', () => {
    const svg = serializeSceneToSvg(
      { elements: [el('i1', 'image', { fileId: 'f1' })], files: { f1: { attachId: 'att1' } } },
      new Map([['f1', { mime: 'image/png', bytes: Buffer.from([1, 2, 3]) }]]),
    )
    expect(svg).toContain('<image')
    expect(svg).toContain('data:image/png;base64,AQID')
  })

  it('skips tombstoned and unknown-type elements', () => {
    const svg = serializeSceneToSvg({
      elements: [
        el('r1', 'rectangle', { isDeleted: true }),
        el('x1', 'totally-unknown'),
        el('r2', 'rectangle', { x: 500 }),
      ],
      files: {},
    })
    // Exactly one drawn rectangle survives (plus the background rect = 2 <rect).
    expect(svg.match(/<rect/g)?.length).toBe(2)
  })
})

describe('rasterizeSvgToPng', () => {
  it('produces PNG bytes with a valid signature', async () => {
    const svg = serializeSceneToSvg({ elements: [el('r1', 'rectangle')], files: {} })
    const png = await rasterizeSvgToPng(svg, { fitWidth: 400 })
    expect(png.length).toBeGreaterThan(8)
    // PNG magic number.
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('renders at the target fitWidth (vector, not an upscaled intrinsic bitmap)', async () => {
    // A small scene (natural width ~148px) asked to render at 800px must come
    // out 800px wide — the vector is re-rendered at the target size rather than
    // the intrinsic SVG being bitmap-upscaled (which would blur shapes/text).
    const svg = serializeSceneToSvg({ elements: [el('r1', 'rectangle')], files: {} })
    const png = await rasterizeSvgToPng(svg, { fitWidth: 800 })
    // PNG width is a big-endian uint32 at byte offset 16 (IHDR).
    const width = png.readUInt32BE(16)
    expect(width).toBe(800)
  })
})

// Skia's SVG engine does not rasterize <image> elements whose href is a
// data-URI, so the board's embedded images are blank when the SVG is decoded.
// The PNG path composites their decoded bytes onto the canvas instead. This
// pins BOTH halves: the Skia gap (baseline) and the compositing that fills it.
describe('rasterizeSvgToPng — image compositing', () => {
  // Decode a PNG and count its roughly-red pixels.
  async function countRedPixels(buf: Buffer): Promise<number> {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const img = await loadImage(buf)
    const c = createCanvas(img.width, img.height)
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0)
    const d = cx.getImageData(0, 0, img.width, img.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > 200 && d[i + 1]! < 80 && d[i + 2]! < 80) n++
    }
    return n
  }

  it('composites resolved image bytes onto the PNG that the SVG data-URI would leave blank', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    // A solid-red 20x20 source image (a real, decodable PNG).
    const src = createCanvas(20, 20)
    const sctx = src.getContext('2d')
    sctx.fillStyle = '#ff0000'
    sctx.fillRect(0, 0, 20, 20)
    const redPng = src.toBuffer('image/png')

    const scene = {
      elements: [el('i1', 'image', { fileId: 'f1', x: 40, y: 40, width: 60, height: 60 })],
      files: { f1: { attachId: 'att1' } },
    }
    const images = new Map([['f1', { mime: 'image/png', bytes: redPng }]])
    const svg = serializeSceneToSvg(scene, images)
    const layout = computeSceneLayout(scene)

    // Baseline: Skia does not render the SVG's data-URI <image>, so the region
    // is blank — no red — without compositing.
    const plain = await rasterizeSvgToPng(svg, { fitWidth: 300 })
    expect(await countRedPixels(plain)).toBe(0)

    // With the resolved bytes composited, the image is painted onto the canvas.
    const composed = await rasterizeSvgToPng(svg, {
      fitWidth: 300,
      composite: { elements: scene.elements, imagesByFileId: images, layout },
    })
    expect(await countRedPixels(composed)).toBeGreaterThan(0)
  })
})

describe('exportBoardHandler', () => {
  beforeEach(() => {
    vi.mocked(requireDocRole).mockReset()
  })

  it('rejects a non-board doc with 409 unsupported_doc_type', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(docGuard)
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'unsupported_doc_type' })
  })

  it('rejects an unrecognized format with 400 invalid_format', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    live.state = liveBoard([el('r1', 'rectangle')])
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }, { format: 'webp' }), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_format' })
  })

  it('returns an SVG (200 image/svg+xml) containing the drawn element', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    live.state = liveBoard([el('r1', 'rectangle', { strokeColor: '#1971c2' })])
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }, { format: 'svg' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.contentType).toBe('image/svg+xml; charset=utf-8')
    expect(String(res.body)).toContain('#1971c2')
    expect(res.headers['Content-Disposition']).toContain('b_1.svg')
  })

  it('returns a PNG (200 image/png) with a valid signature — default format', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    live.state = liveBoard([el('r1', 'rectangle')])
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.contentType).toBe('image/png')
    const png = res.body as Buffer
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(res.headers['Content-Disposition']).toContain('b_1.png')
  })

  it('maps a wrong-kind (prosemirror) blob to 409 board_snapshot_invalid', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    // A document Y.Doc carries a COLLAB_FIELD XmlFragment — never a board shape.
    const doc = new Y.Doc()
    doc.getXmlFragment(COLLAB_FIELD).insert(0, [new Y.XmlText('x')])
    live.state = Y.encodeStateAsUpdate(doc)
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }, { format: 'svg' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'board_snapshot_invalid' })
  })

  it('serves SVG as an attachment with nosniff (defense-in-depth)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    live.state = liveBoard([el('r1', 'rectangle')])
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }, { format: 'svg' }), res as never)
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.headers['Content-Disposition']).toContain('attachment')
  })

  it('serves PNG inline with nosniff', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(boardGuard)
    live.state = liveBoard([el('r1', 'rectangle')])
    const res = mockRes()
    await exportBoardHandler(req({ docId: 'b_1' }), res as never)
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.headers['Content-Disposition']).toContain('inline')
  })
})

// ── output DoS bounds (raster memory-bomb guard) ─────────────────────────────
// The scene geometry is fully attacker-controlled on a reader endpoint, so an
// oversize/extreme-aspect scene must never produce an unbounded (or Infinity)
// canvas or a multi-GB raster. These pin the clamps in serializeSceneToSvg /
// rasterizeSvgToPng.
describe('serializeSceneToSvg — output dimension clamp', () => {
  const svgDim = (svg: string, attr: 'width' | 'height'): number =>
    Number(new RegExp(`<svg[^>]*\\b${attr}="([\\d.]+)"`).exec(svg)?.[1])

  it('clamps a far-flung scene to a bounded finite canvas', () => {
    const svg = serializeSceneToSvg({ elements: [el('r1', 'rectangle', { height: 50_000_000 })], files: {} })
    const h = svgDim(svg, 'height')
    expect(Number.isFinite(h)).toBe(true)
    expect(h).toBeLessThanOrEqual(12_000)
  })

  it('collapses a non-finite (overflowing) extent to the max dimension — never emits Infinity', () => {
    const svg = serializeSceneToSvg({
      elements: [el('a', 'rectangle', { x: -1e308, width: 1 }), el('b', 'rectangle', { x: 1e308, width: 1 })],
      files: {},
    })
    expect(svg).not.toContain('Infinity')
    expect(svgDim(svg, 'width')).toBeLessThanOrEqual(12_000)
  })

  it('respects an explicit maxDimension override', () => {
    const svg = serializeSceneToSvg({ elements: [el('r1', 'rectangle', { width: 999_999 })], files: {} }, new Map(), {
      maxDimension: 500,
    })
    expect(svgDim(svg, 'width')).toBeLessThanOrEqual(500)
  })
})

describe('rasterizeSvgToPng — output pixel-area cap', () => {
  it('bounds the raster for an extreme-aspect scene and still emits a valid PNG', async () => {
    // A tall clamped canvas at a large fit width would be a giant bitmap; the
    // area cap downscales it uniformly instead of letting resvg allocate it.
    const svg = serializeSceneToSvg({ elements: [el('r1', 'rectangle', { height: 50_000_000 })], files: {} })
    const png = await rasterizeSvgToPng(svg, { fitWidth: 2000, maxPixels: 4_000_000 })
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})

// ── injection regression guards (attribute-context + closing-tag payloads) ───
describe('serializeSceneToSvg — injection guards', () => {
  it('escapes a closing-tag/script payload in text so it cannot break out', () => {
    const svg = serializeSceneToSvg({
      elements: [el('t1', 'text', { text: '</text><script>alert(1)</script>' })],
      files: {},
    })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;')
  })

  it('drops a non-whitelisted strokeColor (no attribute-context breakout)', () => {
    const svg = serializeSceneToSvg({
      elements: [el('r1', 'rectangle', { strokeColor: 'red" onload="alert(1)' })],
      files: {},
    })
    expect(svg).not.toContain('onload')
  })
})
