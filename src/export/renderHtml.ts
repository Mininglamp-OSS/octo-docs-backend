/**
 * ProseMirror JSON -> standalone print HTML (server-side PDF export).
 *
 * This is the KEY advantage of the backend Puppeteer approach over the old
 * frontend jsPDF/html2canvas path: math is rendered with server-side KaTeX and
 * the FULL katex CSS (fonts inlined as base64 data URIs) is baked into the
 * document, so formulas render pixel-perfect with no external requests. CJK and
 * emoji come from the headless Chrome font stack (see Dockerfile), and the text
 * stays real, selectable text — not a rasterized canvas.
 *
 * The walk mirrors the shared schema (src/schema/index.ts) node/mark set at
 * SCHEMA_VERSION 15 — never hardcode a node list that can drift from the schema.
 * Emitting the same semantic HTML the Tiptap toDOM would produce keeps the
 * output aligned with what the editor shows.
 *
 * Attachment resolution is intentionally OUT of this module: image / file nodes
 * carry only an `attachId`, and turning that into a signed, time-limited object
 * -store URL requires the backend's own auth context (§3.5). The route resolves
 * every attachId to a signed URL first (docAttachmentRepo + object store presign)
 * and passes the resolved map in, so this module stays a pure, synchronous
 * JSON -> string transform.
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import katex from 'katex'
import { gitHubEmojis } from '@tiptap/extension-emoji'

// Emoji name/shortcode → unicode glyph, built from the SAME `gitHubEmojis`
// set the editor + frontend use. Previously this used `node-emoji`, whose
// shortcode table diverges from GitHub's (e.g. `vomiting_face` was unknown and
// leaked through as the literal `:vomiting_face:` text). Building the map from
// gitHubEmojis keeps backend PDF emoji identical to what the user sees.
const EMOJI_GLYPH_BY_KEY: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const e of gitHubEmojis) {
    if (!e.emoji) continue
    m.set(e.name, e.emoji)
    for (const sc of e.shortcodes ?? []) m.set(sc, e.emoji)
  }
  return m
})()

const require = createRequire(import.meta.url)

/** A resolved attachment reference the route hands us (already signed). */
export interface ResolvedAttachment {
  url: string
  fileName: string
  mime: string
  sizeBytes: number
}

export interface RenderHtmlOptions {
  /** Document title — rendered as the leading H1 and used by the caller for the filename. */
  title: string
  /** attachId -> freshly signed object-store URL + metadata (built by the route). */
  attachments: Map<string, ResolvedAttachment>
}

// ── ProseMirror JSON shapes (structural; the schema is the source of truth) ────
interface PMMark {
  type: string
  attrs?: Record<string, unknown>
}
interface PMNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
  text?: string
  marks?: PMMark[]
}

// ── numeric attr clamping (DoS prevention) ──────────────────────────────────────
/**
 * Clamp a numeric attribute from document content to sane bounds.
 * Document attrs are user-controlled and can be crafted to cause synchronous
 * DoS (e.g. colspan=1e8 spins a loop allocating 100M entries before the
 * Puppeteer queue/timeout applies). All numeric attrs from PM JSON must go
 * through this before being used in loops or allocations.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// ── katex CSS with woff2 fonts inlined as data URIs (built once, memoized) ─────
/**
 * Read katex.min.css and inline every `url(fonts/*.woff2)` reference as a
 * base64 data URI. `page.setContent(html)` has no base URL, so relative font
 * paths would otherwise fail to load and KaTeX would fall back to the wrong
 * metrics. Inlining also means the render needs ZERO external requests, which
 * lets the Puppeteer request interceptor deny everything but the object store.
 * Falls back to the raw CSS (fonts unresolved) if the dist files are missing.
 */
function buildKatexCss(): string {
  try {
    const distDir = join(dirname(require.resolve('katex/package.json')), 'dist')
    const css = readFileSync(join(distDir, 'katex.min.css'), 'utf8')
    const fontsDir = join(distDir, 'fonts')
    const fontData = new Map<string, string>()
    for (const file of readdirSync(fontsDir)) {
      if (file.endsWith('.woff2')) {
        fontData.set(file, readFileSync(join(fontsDir, file)).toString('base64'))
      }
    }
    // Rewrite only the woff2 source (first in each @font-face `src` list); the
    // woff/ttf fallbacks are left as dead relative URLs the browser never fetches
    // because the woff2 data URI already satisfies the face.
    return css.replace(/url\((['"]?)fonts\/([\w-]+\.woff2)\1\)/g, (whole, _q, name: string) => {
      const b64 = fontData.get(name)
      return b64 ? `url(data:font/woff2;base64,${b64})` : whole
    })
  } catch {
    // Best effort: without the package present, math still renders with fallback
    // fonts rather than crashing the export.
    try {
      const distDir = join(dirname(require.resolve('katex/package.json')), 'dist')
      return readFileSync(join(distDir, 'katex.min.css'), 'utf8')
    } catch {
      return ''
    }
  }
}

let katexCssCache: string | null = null
function katexCss(): string {
  if (katexCssCache === null) katexCssCache = buildKatexCss()
  return katexCssCache
}

// ── escaping helpers ───────────────────────────────────────────────────────────
function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, '&quot;')
}

// ── math ─────────────────────────────────────────────────────────────────────
function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })
  } catch {
    // KaTeX already renders parse errors inline (throwOnError:false); this only
    // guards a hard failure. Fall back to the raw source so nothing is lost.
    return `<code>${escText(latex)}</code>`
  }
}

// ── inline marks ───────────────────────────────────────────────────────────────
/**
 * Allow only safe link URL schemes. This HTML is rendered by headless Chrome,
 * so a user-controlled `javascript:` / `data:` / `vbscript:` href is a script
 * injection vector. Permit http(s), mailto, tel, and relative/anchor URLs
 * (no scheme). Leading control chars/whitespace are stripped before the check
 * because browsers ignore them when resolving the scheme (e.g. "java\tscript:").
 */
function isSafeHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/)
  if (!scheme) return true // relative URL or #anchor — no scheme, safe
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1] ?? '')
}

// CSS value guards for user-controlled color / font-size marks. escAttr only
// neutralises `& < > "`, so a raw color like `red;position:fixed;...` would
// still smuggle extra CSS declarations into the inline style attribute. These
// whitelists keep the values to a single well-formed token before we inline
// them (defence in depth — no script exec here, but keeps the style面 tight).
function isSafeCssColor(v: string): boolean {
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{3,8}$/.test(s)) return true
  if (/^rgba?\(\s*[\d.%,\s/]+\)$/.test(s)) return true
  if (/^hsla?\(\s*[\d.%,\s/deg]+\)$/.test(s)) return true
  // Named colours / keywords: letters only (e.g. red, transparent, currentColor).
  if (/^[a-z]+$/.test(s)) return true
  return false
}

function isSafeCssFontSize(v: string): boolean {
  // A number with an optional length/percentage unit, e.g. 14px, 1.2em, 120%.
  return /^\d+(\.\d+)?(px|pt|em|rem|%)?$/.test(v.trim())
}

function wrapMark(mark: PMMark, inner: string): string {
  const attrs = mark.attrs ?? {}
  switch (mark.type) {
    case 'bold':
      return `<strong>${inner}</strong>`
    case 'italic':
      return `<em>${inner}</em>`
    case 'underline':
      return `<u>${inner}</u>`
    case 'strike':
      return `<s>${inner}</s>`
    case 'code':
      return `<code>${inner}</code>`
    case 'superscript':
      return `<sup>${inner}</sup>`
    case 'subscript':
      return `<sub>${inner}</sub>`
    case 'highlight': {
      const color = attrs.color as string | null
      return color && isSafeCssColor(String(color))
        ? `<mark style="background-color:${escAttr(color)}">${inner}</mark>`
        : `<mark>${inner}</mark>`
    }
    case 'textStyle': {
      const styles: string[] = []
      if (attrs.color && isSafeCssColor(String(attrs.color))) styles.push(`color:${escAttr(String(attrs.color))}`)
      if (attrs.fontSize && isSafeCssFontSize(String(attrs.fontSize))) styles.push(`font-size:${escAttr(String(attrs.fontSize))}`)
      return styles.length ? `<span style="${styles.join(';')}">${inner}</span>` : inner
    }
    case 'link': {
      const href = attrs.href as string | null
      if (!href) return inner
      // Only allow safe URL schemes. A doc's link href is user-controlled and
      // this HTML is loaded into a headless Chrome page for rendering, so a
      // `javascript:` / `data:` / `vbscript:` href could execute script or
      // smuggle content. Reject anything that isn't http(s)/mailto/tel or a
      // relative/anchor URL, and render it as plain (still-selectable) text.
      if (!isSafeHref(href)) return inner
      // rel/target are irrelevant in a PDF, but href stays so the link is
      // clickable and selectable in the output.
      return `<a href="${escAttr(href)}">${inner}</a>`
    }
    default:
      return inner
  }
}

function renderTextNode(node: PMNode): string {
  let html = escText(node.text ?? '')
  // Wrap inner-out: the first mark in the array is the innermost wrapper.
  for (const mark of node.marks ?? []) html = wrapMark(mark, html)
  return html
}

// ── block / inline nodes ───────────────────────────────────────────────────────
const VALID_TEXT_ALIGNS = new Set(['left', 'right', 'center', 'justify'])

function textAlignStyle(attrs: Record<string, unknown> | undefined): string {
  const align = attrs?.textAlign as string | null | undefined
  if (!align || !VALID_TEXT_ALIGNS.has(align)) return ''
  return ` style="text-align:${align}"`
}

function renderChildren(node: PMNode, ctx: RenderCtx): string {
  return (node.content ?? []).map((child) => renderNode(child, ctx)).join('')
}

/**
 * Build a <colgroup> for a ProseMirror table from the first row's cell
 * `colwidth` attrs so exported column widths match the editor.
 *
 * Each cell's `colwidth` is an array (length = colspan) of pixel widths or
 * null. We walk the first row, expanding colspans, to collect one width per
 * column. If NO column has an explicit width we emit nothing (let the browser
 * auto-size, same as before). Columns without a set width get `width:auto`.
 */
function tableColgroup(table: PMNode): string {
  const firstRow = (table.content ?? []).find((n) => n.type === 'tableRow')
  if (!firstRow) return ''
  const widths: (number | null)[] = []
  for (const cell of firstRow.content ?? []) {
    const attrs = cell.attrs ?? {}
    const colspan = clampInt(attrs.colspan, 1, 100, 1)
    const cw = Array.isArray(attrs.colwidth) ? (attrs.colwidth as unknown[]) : null
    for (let i = 0; i < colspan; i++) {
      // Treat only a finite POSITIVE number as an explicit width. colwidth
      // entries are commonly `null` (unset); guard against 0 / negative /
      // NaN so a bogus value can't emit a `width:0px` col or wrongly flip the
      // table into fixed layout.
      const raw = cw ? cw[i] : null
      const w = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null
      widths.push(w)
    }
  }
  if (widths.length === 0 || widths.every((w) => w == null)) return ''
  const cols = widths
    .map((w) => (w != null ? `<col style="width:${w}px" />` : '<col />'))
    .join('')
  return `<colgroup>${cols}</colgroup>`
}

/** Max nesting depth for renderNode recursion. Prevents stack overflow from
 *  pathologically nested docs (e.g. 5000-deep blockquotes). The schema allows
 *  unbounded self-nesting; this cap is a defense-in-depth limit well above any
 *  legitimate document structure. */
const MAX_RENDER_DEPTH = 200

interface RenderCtx {
  attachments: Map<string, ResolvedAttachment>
  /** Current recursion depth — incremented in renderNode, checked before recurse. */
  depth?: number
}

function renderImage(node: PMNode, ctx: RenderCtx): string {
  const attrs = node.attrs ?? {}
  const attachId = attrs.attachId as string | null
  const _rawSrc = attrs.src as string | null
  let src: string | null = null
  if (attachId && ctx.attachments.has(attachId)) {
    src = ctx.attachments.get(attachId)!.url
  }
  // Do NOT fall back to raw attrs.src — writer-controlled URLs could target
  // internal services. Only backend-resolved signed attachment URLs are trusted.
  // The Puppeteer request interceptor is the load-time backstop but we should
  // not emit untrusted URLs into the HTML at all.
  if (!src) return ''
  const alt = attrs.alt as string | null
  const width = attrs.width as string | null
  // Only allow safe CSS width values (number+unit or percentage). Blocks injection.
  const safeWidth = width && /^(?:\d+(?:\.\d+)?(?:px|%|em|rem))$/.test(String(width)) ? String(width) : null
  const style = safeWidth ? ` style="width:${escAttr(safeWidth)}"` : ''
  return `<figure class="img"><img src="${escAttr(src)}"${alt ? ` alt="${escAttr(alt)}"` : ''}${style} /></figure>`
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function renderFileAttachment(node: PMNode, ctx: RenderCtx): string {
  const attrs = node.attrs ?? {}
  const attachId = attrs.attachId as string | null
  const resolved = attachId ? ctx.attachments.get(attachId) : undefined
  const fileName = escText(String(attrs.fileName ?? resolved?.fileName ?? 'file'))
  const size = humanSize(Number(attrs.sizeBytes ?? resolved?.sizeBytes ?? 0))
  const meta = size ? `<div class="file-meta">${size}</div>` : ''
  return `<div class="file-attachment"><div class="file-name">📎 ${fileName}</div>${meta}</div>`
}

function renderBookmark(node: PMNode): string {
  const attrs = node.attrs ?? {}
  const url = attrs.url as string | null
  const title = escText(String(attrs.title ?? url ?? ''))
  const description = attrs.description ? escText(String(attrs.description)) : ''
  const siteName = attrs.siteName ? escText(String(attrs.siteName)) : ''
  // The bookmark thumbnail is external by definition; the request interceptor
  // would block it, so render a text-only card (title / description / url).
  return (
    `<div class="bookmark">` +
    `<div class="bookmark-title">${title}</div>` +
    (description ? `<div class="bookmark-desc">${description}</div>` : '') +
    (url ? `<div class="bookmark-url">${siteName ? escText(siteName) + ' · ' : ''}${escText(url)}</div>` : '') +
    `</div>`
  )
}

const CALLOUT_ICON: Record<string, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  tip: '💡',
  success: '✅',
}

function renderNode(node: PMNode, ctx: RenderCtx): string {
  const depth = (ctx.depth ?? 0) + 1
  if (depth > MAX_RENDER_DEPTH) return '<!-- max render depth exceeded -->'
  const attrs = node.attrs ?? {}
  const childCtx = { ...ctx, depth }
  switch (node.type) {
    case 'text':
      return renderTextNode(node)
    case 'paragraph':
      return `<p${textAlignStyle(attrs)}>${renderChildren(node, childCtx)}</p>`
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs.level ?? 1)))
      return `<h${level}${textAlignStyle(attrs)}>${renderChildren(node, childCtx)}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${renderChildren(node, childCtx)}</ul>`
    case 'orderedList': {
      const start = clampInt(attrs.start, 1, 99999, 1)
      return `<ol${start !== 1 ? ` start="${start}"` : ''}>${renderChildren(node, childCtx)}</ol>`
    }
    case 'listItem':
      return `<li>${renderChildren(node, childCtx)}</li>`
    case 'taskList':
      return `<ul class="task-list">${renderChildren(node, childCtx)}</ul>`
    case 'taskItem': {
      const box = attrs.checked ? '☑' : '☐'
      return `<li class="task-item"><span class="task-check">${box}</span><div class="task-body">${renderChildren(node, childCtx)}</div></li>`
    }
    case 'blockquote':
      return `<blockquote>${renderChildren(node, childCtx)}</blockquote>`
    case 'codeBlock': {
      const lang = attrs.language as string | null
      return `<pre${lang ? ` data-language="${escAttr(lang)}"` : ''}><code>${renderChildren(node, childCtx)}</code></pre>`
    }
    case 'horizontalRule':
      return '<hr />'
    case 'hardBreak':
      return '<br />'
    case 'image':
      return renderImage(node, ctx)
    case 'table': {
      // ProseMirror tables store per-column widths in each cell's `colwidth`
      // attr (an array aligned to the columns the cell spans). The editor uses
      // these for column sizing; if we drop them the browser auto-distributes
      // widths and the PDF columns look different from the editor. Rebuild a
      // <colgroup> from the first row's cells.
      //
      // IMPORTANT: `table-layout: fixed` is applied UNCONDITIONALLY in the CSS
      // (see the .table rule) to mirror the editor, which renders every table
      // with `table-layout: fixed` (frontend styles.css). The rebuilt
      // <colgroup> below only CARRIES explicit column widths when the user set
      // them; when there are none we emit no colgroup and fixed layout splits
      // columns EVENLY — which is exactly what the editor shows for un-resized
      // tables. So fixed is always on; only the colgroup is conditional.
      const cols = tableColgroup(node)
      const cls = cols ? ' class="has-colwidth"' : ''
      // If the first row is a header row (all cells are tableHeader), emit it
      // inside <thead> so `thead { display: table-header-group }` repeats it on
      // every page a long table spans. Rows that are NOT a pure header row all
      // go in <tbody>.
      const rows = (node.content ?? []).filter((r) => r.type === 'tableRow')
      const first = rows[0]
      const firstIsHeader =
        !!first &&
        (first.content ?? []).length > 0 &&
        (first.content ?? []).every((c) => c.type === 'tableHeader')
      if (firstIsHeader) {
        const thead = renderNode(first, ctx)
        const body = rows.slice(1).map((r) => renderNode(r, ctx)).join('')
        return `<table${cls}>${cols}<thead>${thead}</thead><tbody>${body}</tbody></table>`
      }
      return `<table${cls}>${cols}<tbody>${renderChildren(node, childCtx)}</tbody></table>`
    }
    case 'tableRow':
      return `<tr>${renderChildren(node, childCtx)}</tr>`
    case 'tableCell':
    case 'tableHeader': {
      const tag = node.type === 'tableHeader' ? 'th' : 'td'
      const colspan = clampInt(attrs.colspan, 1, 100, 1)
      const rowspan = clampInt(attrs.rowspan, 1, 100, 1)
      const align = attrs.align as string | null
      const parts: string[] = []
      if (colspan !== 1) parts.push(`colspan="${colspan}"`)
      if (rowspan !== 1) parts.push(`rowspan="${rowspan}"`)
      if (align && VALID_TEXT_ALIGNS.has(align)) parts.push(`style="text-align:${align}"`)
      return `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}>${renderChildren(node, childCtx)}</${tag}>`
    }
    case 'emoji': {
      // The emoji node stores a GitHub shortcode/name (e.g. "smile"). Resolve it
      // via the gitHubEmojis map (same set the editor/DOCX export use) so
      // headless Chrome renders it in color via Noto Color Emoji, and so it
      // matches exactly what the user authored. Fall back to `:name:` only when
      // the shortcode is genuinely unknown.
      const name = attrs.name as string | null
      if (!name) return ''
      const glyph = EMOJI_GLYPH_BY_KEY.get(name)
      if (glyph) return `<span class="emoji">${escText(glyph)}</span>`
      return `:${escText(name)}:`
    }
    case 'mention': {
      const label = attrs.label as string | null
      const char = (attrs.mentionSuggestionChar as string) || '@'
      return `<span class="mention">${escText(char)}${escText(label ?? '')}</span>`
    }
    case 'details':
      return `<details class="details" open>${renderChildren(node, childCtx)}</details>`
    case 'detailsSummary':
      return `<summary>${renderChildren(node, childCtx)}</summary>`
    case 'detailsContent':
      return `<div class="details-content">${renderChildren(node, childCtx)}</div>`
    case 'callout': {
      const variant = (attrs.variant as string) || 'info'
      const icon = CALLOUT_ICON[variant] ?? CALLOUT_ICON.info
      return `<div class="callout callout-${escAttr(variant)}"><span class="callout-icon">${icon}</span><div class="callout-body">${renderChildren(node, childCtx)}</div></div>`
    }
    case 'inlineMath':
      return renderMath(String(attrs.latex ?? ''), false)
    case 'blockMath':
      return `<div class="block-math">${renderMath(String(attrs.latex ?? ''), true)}</div>`
    case 'fileAttachment':
      return renderFileAttachment(node, ctx)
    case 'bookmark':
      return renderBookmark(node)
    default:
      // Unknown node: render its children so text is never silently dropped.
      return renderChildren(node, childCtx)
  }
}

// ── print CSS ──────────────────────────────────────────────────────────────────
/**
 * A4 print CSS: page size + margins via @page, a CJK-first font stack, and
 * page-break-inside: avoid on the elements that look broken when split across
 * pages (tables, code, blockquotes, images, callouts). Puppeteer's page.pdf
 * honours @page and the break rules with printBackground:true.
 */
const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans",
      "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji",
      "Noto Color Emoji", sans-serif;
    font-size: 12pt;
    line-height: 1.7;
    color: #1f2328;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .doc-title { font-size: 22pt; font-weight: 700; margin: 0 0 12pt; }
  /* Emoji: prefer the color emoji font so glyphs render in color, not tofu. */
  .emoji {
    /* Apple Color Emoji first so macOS (dev + any mac render host) uses the
       system colour-emoji font, which covers the full standard set (e.g. 💮
       U+1F4AE that showed as tofu when a partial "Noto Color Emoji" was
       matched first). Noto Color Emoji stays in the stack for Linux/Docker
       render hosts where Apple's font is absent. */
    font-family: "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji",
      "Noto Emoji", sans-serif;
    font-style: normal;
  }
  /* CJK has no true italic cut; force an oblique transform so italic still
     reads as slanted (matches editor faux-italic) rather than rendering upright. */
  em, i { font-style: italic; font-synthesis: style; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em; font-weight: 700; }
  h1 { font-size: 18pt; }
  h2 { font-size: 16pt; }
  h3 { font-size: 14pt; }
  h4, h5, h6 { font-size: 12pt; }
  /* Preserve leading / consecutive spaces the user typed (the editor renders
     the ProseMirror doc with white-space: pre-wrap, so a paragraph that starts
     with spaces shows that indent). Default HTML white-space:normal collapses
     leading and repeated spaces, which dropped those indents in the PDF.
     pre-wrap keeps the spaces while still wrapping long lines at the margin. */
  p { margin: 0.5em 0; white-space: pre-wrap; }
  ul, ol { margin: 0.5em 0; padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  ul.task-list { list-style: none; padding-left: 0.3em; }
  li.task-item { display: flex; align-items: flex-start; gap: 0.4em; }
  li.task-item .task-check { flex: 0 0 auto; }
  li.task-item .task-body { flex: 1 1 auto; }
  li.task-item .task-body > p { margin: 0; }
  blockquote {
    margin: 0.8em 0; padding: 0.4em 1em; color: #57606a;
    border-left: 4px solid #d0d7de; background: #f6f8fa;
  }
  pre {
    margin: 0.8em 0; padding: 12px 14px; background: #f6f8fa; border-radius: 6px;
    font-family: "SFMono-Regular", "Cascadia Code", Consolas, "Liberation Mono", monospace;
    font-size: 10.5pt; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
  code { font-family: "SFMono-Regular", "Cascadia Code", Consolas, "Liberation Mono", monospace; font-size: 0.9em; }
  p code, li code { background: #eff1f3; border-radius: 4px; padding: 0.1em 0.3em; }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 1.2em 0; }
  a { color: #0969da; text-decoration: underline; }
  mark { padding: 0 0.1em; }
  figure.img { margin: 0.8em 0; text-align: center; }
  figure.img img { max-width: 100%; height: auto; }
  table {
    border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 11pt;
    table-layout: fixed; word-break: break-word;
  }
  /* The editor renders every table with table-layout: fixed (see the
     frontend .octo-prose table rule): columns are equal-width by default and
     honour explicit colwidth when set. Match that here unconditionally so the
     PDF column layout mirrors the editor. A rebuilt colgroup (below) carries
     any explicit widths; without it, fixed layout splits columns evenly,
     which is exactly what the editor shows for un-resized tables. */
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  /* Repeat the header row on every page a long table spans, and keep
     individual rows from splitting across a page break. The table itself
     is allowed to break across pages (removing page-break-inside: avoid on
     the table) so a long table no longer gets pushed wholesale to the next
     page, which left a big blank under the preceding heading. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .mention { color: #0969da; background: #ddf4ff; border-radius: 4px; padding: 0 0.2em; }
  details.details { margin: 0.8em 0; border: 1px solid #d0d7de; border-radius: 6px; padding: 0.4em 0.8em; }
  details.details > summary { font-weight: 600; cursor: default; }
  .details-content { margin-top: 0.4em; }
  .callout {
    display: flex; gap: 0.6em; margin: 0.8em 0; padding: 0.6em 0.9em;
    border-radius: 8px; border: 1px solid transparent; background: transparent;
  }
  .callout .callout-icon { flex: 0 0 auto; }
  .callout .callout-body { flex: 1 1 auto; }
  .callout .callout-body > :first-child { margin-top: 0; }
  .callout .callout-body > :last-child { margin-bottom: 0; }
  .callout-info { background: rgba(22, 100, 255, 0.08); border-color: rgba(22, 100, 255, 0.2); }
  .callout-warn { background: rgba(247, 144, 9, 0.1); border-color: rgba(247, 144, 9, 0.25); }
  .callout-tip { background: rgba(0, 180, 42, 0.08); border-color: rgba(0, 180, 42, 0.2); }
  .callout-success { background: rgba(0, 180, 42, 0.12); border-color: rgba(0, 180, 42, 0.3); }
  .block-math { margin: 0.6em 0; text-align: center; page-break-inside: avoid; overflow-x: auto; }
  /* KaTeX display math adds its own 1em top/bottom margin; the .block-math
     wrapper already provides spacing, so zero out the inner margin to avoid
     the two stacking into an oversized gap between consecutive formulas. */
  .block-math .katex-display { margin: 0; }
  .file-attachment {
    margin: 0.8em 0; padding: 0.6em 0.9em; border: 1px solid #d0d7de;
    border-radius: 6px; background: #f6f8fa;
  }
  .file-attachment .file-name { font-weight: 600; }
  .file-attachment .file-meta { color: #57606a; font-size: 10pt; margin-top: 0.2em; }
  .bookmark {
    margin: 0.8em 0; padding: 0.6em 0.9em; border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .bookmark .bookmark-title { font-weight: 600; }
  .bookmark .bookmark-desc { color: #57606a; font-size: 10.5pt; margin-top: 0.2em; }
  .bookmark .bookmark-url { color: #0969da; font-size: 10pt; margin-top: 0.3em; word-break: break-all; }
`

/**
 * Convert a ProseMirror document JSON to a full standalone HTML string ready for
 * Puppeteer `setContent`. The KaTeX stylesheet (with inlined fonts) and the
 * print CSS are both embedded so the page needs no stylesheet requests.
 */
export function renderHtml(pmDoc: unknown, opts: RenderHtmlOptions): string {
  const doc = pmDoc as PMNode | null
  const ctx: RenderCtx = { attachments: opts.attachments }
  const body =
    doc && doc.content ? doc.content.map((child) => renderNode(child, ctx)).join('') : ''
  const title = escText(opts.title || '未命名文档')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${katexCss()}</style>
<style>${PRINT_CSS}</style>
</head>
<body>
<h1 class="doc-title">${title}</h1>
${body}
</body>
</html>`
}
