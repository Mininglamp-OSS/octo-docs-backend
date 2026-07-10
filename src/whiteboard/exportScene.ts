/**
 * Server-side whiteboard (Excalidraw) scene → image serialization (W3).
 *
 * The board has no persisted image on the server; the front-end exports it in
 * the browser with Excalidraw's own canvas renderer. To offer a bot/API export
 * without shipping a headless browser (see the W3 renderer-selection spike), we
 * serialize the decoded `{elements, files}` scene to SVG directly here, and
 * rasterize that SVG to PNG with `@resvg/resvg-js` — a Rust/napi library that
 * ships prebuilt musl binaries (no system libraries, no resident process, no
 * network), matching the node:22-alpine deploy image and the same short-lived,
 * sandboxed philosophy as the Typst PDF path.
 *
 * The element set mirrors `WB_ELEMENT_TYPES` (the Excalidraw v1 subset the
 * front-end binding emits). This is a faithful STRUCTURAL export — shapes,
 * geometry, colors, text and embedded images (resolved by attachId) — rendered
 * with clean geometric strokes rather than Excalidraw's Rough.js hand-drawn
 * look. Fill styles (hachure / cross-hatch) are approximated as a solid fill.
 * Raising stroke fidelity to the sketchy on-canvas style (via roughjs's
 * generator, which is pure-JS and container-safe) is a documented follow-up.
 */

/** Raw decoded scene (from decodeBoardSnapshot in collab/versionRestore.ts). */
export interface SceneInput {
  elements: Array<Record<string, unknown>>
  files: Record<string, Record<string, unknown>>
}

/** Resolved image bytes for an image element, keyed by the element's fileId. */
export interface ResolvedSceneImage {
  mime: string
  bytes: Buffer
}

// ── small typed readers over the untyped element maps ─────────────────────────

function numOf(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function strOf(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** XML/SVG text-content and attribute escaping. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Round to 2dp so the SVG stays compact and deterministic. */
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** A CSS/SVG color is safe to inline only if it is a simple color token. */
function safeColor(v: unknown, fallback: string): string {
  const s = strOf(v).trim()
  if (!s) return fallback
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/.test(s)) return s
  if (/^[a-zA-Z]{1,20}$/.test(s)) return s // named color (transparent, white, …)
  return fallback
}

interface Pt {
  x: number
  y: number
}

/** Element `points` are stored relative to the element origin (x, y). */
function absolutePoints(el: Record<string, unknown>): Pt[] {
  const ox = numOf(el.x)
  const oy = numOf(el.y)
  const raw = Array.isArray(el.points) ? (el.points as unknown[]) : []
  const out: Pt[] = []
  for (const p of raw) {
    if (Array.isArray(p) && p.length >= 2) {
      out.push({ x: ox + numOf(p[0]), y: oy + numOf(p[1]) })
    }
  }
  return out
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function isDeleted(el: Record<string, unknown>): boolean {
  return el.isDeleted === true
}

function renderableType(el: Record<string, unknown>): string {
  return strOf(el.type)
}

/** Scene bounding box across every non-deleted element (points included). */
function sceneBounds(elements: Array<Record<string, unknown>>): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  const grow = (x: number, y: number): void => {
    any = true
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const el of elements) {
    if (isDeleted(el) || !renderableType(el)) continue
    const x = numOf(el.x)
    const y = numOf(el.y)
    const w = numOf(el.width)
    let h = numOf(el.height)
    // A text element occasionally arrives without a computed height (the editor
    // normally sets it). Estimate from its line count so multi-line text is not
    // clipped by a too-tight scene box.
    if (renderableType(el) === 'text') {
      const fontSize = numOf(el.fontSize, 20)
      const lineHeight = numOf(el.lineHeight, 1.25) || 1.25
      const lines = strOf(el.text).split('\n').length
      h = Math.max(h, lines * fontSize * lineHeight)
    }
    grow(x, y)
    grow(x + w, y + h)
    for (const p of absolutePoints(el)) grow(p.x, p.y)
  }
  return any ? { minX, minY, maxX, maxY } : null
}

/** Dash pattern for strokeStyle, scaled by stroke width (Excalidraw-ish). */
function dashArray(strokeStyle: string, sw: number): string | null {
  if (strokeStyle === 'dashed') return `${r2(sw * 4)} ${r2(sw * 4)}`
  if (strokeStyle === 'dotted') return `${r2(sw * 1)} ${r2(sw * 3)}`
  return null
}

/** Common presentation attributes shared by the shape primitives. */
function shapeAttrs(el: Record<string, unknown>): string {
  const stroke = safeColor(el.strokeColor, '#1e1e1e')
  const bg = strOf(el.backgroundColor, 'transparent')
  const fill = bg && bg !== 'transparent' ? safeColor(bg, 'none') : 'none'
  const sw = Math.max(0, numOf(el.strokeWidth, 1))
  const parts = [
    `fill="${fill}"`,
    `stroke="${stroke}"`,
    `stroke-width="${r2(sw)}"`,
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
  ]
  const dash = dashArray(strOf(el.strokeStyle, 'solid'), sw || 1)
  if (dash) parts.push(`stroke-dasharray="${dash}"`)
  return parts.join(' ')
}

/** Wrap a fragment in a <g> that applies opacity and rotation about its center. */
function wrap(el: Record<string, unknown>, inner: string): string {
  const opacityRaw = numOf(el.opacity, 100)
  const opacity = Math.max(0, Math.min(1, opacityRaw / 100))
  const angle = numOf(el.angle, 0)
  const attrs: string[] = []
  if (opacity < 1) attrs.push(`opacity="${r2(opacity)}"`)
  if (angle) {
    const cx = numOf(el.x) + numOf(el.width) / 2
    const cy = numOf(el.y) + numOf(el.height) / 2
    const deg = (angle * 180) / Math.PI
    attrs.push(`transform="rotate(${r2(deg)} ${r2(cx)} ${r2(cy)})"`)
  }
  return attrs.length ? `<g ${attrs.join(' ')}>${inner}</g>` : inner
}

function renderRectangle(el: Record<string, unknown>): string {
  const x = numOf(el.x)
  const y = numOf(el.y)
  const w = numOf(el.width)
  const h = numOf(el.height)
  const rounded = el.roundness != null
  const rx = rounded ? Math.min(32, Math.min(Math.abs(w), Math.abs(h)) * 0.25) : 0
  const rxAttr = rx > 0 ? ` rx="${r2(rx)}" ry="${r2(rx)}"` : ''
  return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}"${rxAttr} ${shapeAttrs(el)} />`
}

function renderEllipse(el: Record<string, unknown>): string {
  const w = numOf(el.width)
  const h = numOf(el.height)
  const cx = numOf(el.x) + w / 2
  const cy = numOf(el.y) + h / 2
  return `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(Math.abs(w) / 2)}" ry="${r2(Math.abs(h) / 2)}" ${shapeAttrs(el)} />`
}

function renderDiamond(el: Record<string, unknown>): string {
  const x = numOf(el.x)
  const y = numOf(el.y)
  const w = numOf(el.width)
  const h = numOf(el.height)
  const pts = [
    { x: x + w / 2, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 },
  ]
    .map((p) => `${r2(p.x)},${r2(p.y)}`)
    .join(' ')
  return `<polygon points="${pts}" ${shapeAttrs(el)} />`
}

/** Arrowhead triangle at the last point, oriented along the final segment. */
function arrowHead(points: Pt[], color: string, sw: number): string {
  if (points.length < 2) return ''
  const p = points[points.length - 1]!
  const q = points[points.length - 2]!
  const dx = p.x - q.x
  const dy = p.y - q.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return ''
  const ux = dx / len
  const uy = dy / len
  const size = Math.max(8, sw * 4)
  // Two base points offset perpendicular from a point `size` back along the line.
  const bx = p.x - ux * size
  const by = p.y - uy * size
  const nx = -uy
  const ny = ux
  const half = size * 0.4
  const a = `${r2(p.x)},${r2(p.y)}`
  const b = `${r2(bx + nx * half)},${r2(by + ny * half)}`
  const c = `${r2(bx - nx * half)},${r2(by - ny * half)}`
  return `<polygon points="${a} ${b} ${c}" fill="${color}" stroke="none" />`
}

function renderLinear(el: Record<string, unknown>, withArrow: boolean): string {
  const points = absolutePoints(el)
  if (points.length < 2) return ''
  const stroke = safeColor(el.strokeColor, '#1e1e1e')
  const sw = Math.max(0, numOf(el.strokeWidth, 1)) || 1
  const dash = dashArray(strOf(el.strokeStyle, 'solid'), sw)
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : ''
  const d = points.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' ')
  const line = `<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="${r2(sw)}" stroke-linecap="round" stroke-linejoin="round"${dashAttr} />`
  // Default Excalidraw arrows carry an end arrowhead; honor an explicit null.
  const wantHead = withArrow && el.endArrowhead !== null
  return line + (wantHead ? arrowHead(points, stroke, sw) : '')
}

function renderFreedraw(el: Record<string, unknown>): string {
  const points = absolutePoints(el)
  if (points.length < 2) return ''
  const stroke = safeColor(el.strokeColor, '#1e1e1e')
  const sw = Math.max(1, numOf(el.strokeWidth, 1) * 1.5)
  const d = points.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' ')
  return `<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="${r2(sw)}" stroke-linecap="round" stroke-linejoin="round" />`
}

/** Map Excalidraw fontFamily codes to a generic family resvg/fontdb can match. */
function fontFamily(code: unknown): string {
  const c = numOf(code, 1)
  if (c === 3) return 'monospace'
  if (c === 2) return 'sans-serif'
  return 'sans-serif' // 1 = hand-drawn (Virgil); fall back to sans-serif
}

function renderText(el: Record<string, unknown>): string {
  const raw = strOf(el.text)
  if (!raw) return ''
  const x = numOf(el.x)
  const y = numOf(el.y)
  const fontSize = numOf(el.fontSize, 20)
  const lineHeight = numOf(el.lineHeight, 1.25) || 1.25
  const fill = safeColor(el.strokeColor, '#1e1e1e')
  const align = strOf(el.textAlign, 'left')
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
  const w = numOf(el.width)
  const anchorX = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x
  const lines = raw.split('\n')
  const step = fontSize * lineHeight
  const tspans = lines
    .map((line, i) => {
      // First baseline sits ~one ascent below the element's top edge.
      const dy = i === 0 ? fontSize * 0.9 : step
      return `<tspan x="${r2(anchorX)}" dy="${r2(dy)}">${esc(line)}</tspan>`
    })
    .join('')
  return `<text x="${r2(anchorX)}" y="${r2(y)}" font-family="${fontFamily(el.fontFamily)}" font-size="${r2(fontSize)}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${tspans}</text>`
}

function renderImage(el: Record<string, unknown>, image: ResolvedSceneImage | undefined): string {
  const x = numOf(el.x)
  const y = numOf(el.y)
  const w = numOf(el.width)
  const h = numOf(el.height)
  if (!image) {
    // Unresolved binary (dev synthetic host, missing/oversize) → light placeholder.
    return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="#f1f3f5" stroke="#ced4da" stroke-width="1" stroke-dasharray="4 4" />`
  }
  const b64 = image.bytes.toString('base64')
  const href = `data:${image.mime};base64,${b64}`
  return `<image x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" preserveAspectRatio="none" href="${href}" />`
}

function renderFrame(el: Record<string, unknown>): string {
  const x = numOf(el.x)
  const y = numOf(el.y)
  const w = numOf(el.width)
  const h = numOf(el.height)
  const name = strOf(el.name)
  const label = name
    ? `<text x="${r2(x)}" y="${r2(y - 6)}" font-family="sans-serif" font-size="14" fill="#868e96">${esc(name)}</text>`
    : ''
  return `${label}<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="none" stroke="#adb5bd" stroke-width="1.5" rx="6" ry="6" />`
}

function renderEmbeddable(el: Record<string, unknown>): string {
  const x = numOf(el.x)
  const y = numOf(el.y)
  const w = numOf(el.width)
  const h = numOf(el.height)
  return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="#f8f9fa" stroke="#868e96" stroke-width="1.5" rx="6" ry="6" />`
}

function renderElement(
  el: Record<string, unknown>,
  imagesByFileId: Map<string, ResolvedSceneImage>,
): string {
  switch (renderableType(el)) {
    case 'rectangle':
      return renderRectangle(el)
    case 'ellipse':
      return renderEllipse(el)
    case 'diamond':
      return renderDiamond(el)
    case 'line':
      return renderLinear(el, false)
    case 'arrow':
      return renderLinear(el, true)
    case 'freedraw':
      return renderFreedraw(el)
    case 'text':
      return renderText(el)
    case 'image': {
      const fileId = strOf(el.fileId)
      return renderImage(el, fileId ? imagesByFileId.get(fileId) : undefined)
    }
    case 'frame':
      return renderFrame(el)
    case 'embeddable':
      return renderEmbeddable(el)
    default:
      return '' // unknown/unrenderable type — skip (mirrors repair's whitelist)
  }
}

/**
 * Serialize a decoded board scene to a standalone SVG document string.
 * `imagesByFileId` carries the resolved bytes for image elements (best-effort;
 * a missing entry renders a light placeholder). A scene with no renderable
 * element yields a small blank white canvas (a valid, openable export).
 */
export function serializeSceneToSvg(
  scene: SceneInput,
  imagesByFileId: Map<string, ResolvedSceneImage> = new Map(),
): string {
  const elements = scene.elements.filter((el) => !isDeleted(el) && renderableType(el))
  const bounds = sceneBounds(elements)
  const pad = 24
  const minX = bounds ? bounds.minX - pad : 0
  const minY = bounds ? bounds.minY - pad : 0
  const width = bounds ? Math.max(1, bounds.maxX - bounds.minX + pad * 2) : 100
  const height = bounds ? Math.max(1, bounds.maxY - bounds.minY + pad * 2) : 100

  const body = elements.map((el) => wrap(el, renderElement(el, imagesByFileId))).join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${r2(width)}" height="${r2(height)}" ` +
    `viewBox="${r2(minX)} ${r2(minY)} ${r2(width)} ${r2(height)}">` +
    `<rect x="${r2(minX)}" y="${r2(minY)}" width="${r2(width)}" height="${r2(height)}" fill="#ffffff" />` +
    body +
    `</svg>`
  )
}

/**
 * Rasterize an SVG document to PNG bytes with `@resvg/resvg-js`. Lazy-loaded so
 * the SVG path never depends on the native binary being resolvable, and so a
 * platform without a prebuilt binary fails only on PNG (not on module import).
 */
export async function rasterizeSvgToPng(
  svg: string,
  opts: { fitWidth?: number } = {},
): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js')
  const fitTo =
    opts.fitWidth && opts.fitWidth > 0
      ? ({ mode: 'width', value: Math.round(opts.fitWidth) } as const)
      : ({ mode: 'original' } as const)
  const resvg = new Resvg(svg, {
    background: 'white',
    fitTo,
    font: { loadSystemFonts: true },
  })
  const rendered = resvg.render()
  return Buffer.from(rendered.asPng())
}
