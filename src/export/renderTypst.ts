/**
 * ProseMirror JSON -> Typst markup (server-side PDF export).
 *
 * The document is rendered to Typst source and compiled with the standalone
 * `typst` binary. Typst is a modern LaTeX-class typesetting engine: real
 * hyphenation, professional pagination, native math — while being a single
 * ~40MB static binary with millisecond compiles and NO resident process.
 *
 * Notes on fidelity:
 *   + small footprint (no browser, no TeX Live), fast, low memory
 *   + LaTeX-quality pagination / line breaking
 *   ~ math is converted LaTeX -> Typst math (common constructs covered; exotic
 *     macros fall back to a verbatim source span so nothing is silently lost)
 *   ~ inline CSS colours / font-sizes map to Typst text() where representable
 *
 * The node/mark walk follows the shared editor schema node set
 * (SCHEMA_VERSION 15). Attachment resolution stays OUT of this module (§3.5):
 * the route resolves attachId -> local image path first and passes the map in,
 * keeping this a pure, synchronous JSON -> string transform.
 *
 * SECURITY: All emitted Typst content strings go through `esc()` (Typst string
 * escaping) or `escContent()` (Typst markup escaping) so document text can never
 * break out into Typst code. User-controlled URLs go through the same isSafeHref
 * whitelist as the HTML path; colours / font-sizes are whitelisted before use.
 */
import { gitHubEmojis } from '@tiptap/extension-emoji'

/** A resolved attachment reference the route hands us (already signed). */
export interface ResolvedAttachment {
  url: string
  fileName: string
  mime: string
  sizeBytes: number
}

export interface RenderTypstOptions {
  /** Document title — rendered as the leading H1 / used by the caller for the filename. */
  title: string
  /** attachId -> resolved attachment metadata. Images are embedded as bytes by
   *  the route (Typst compiles offline, so we cannot fetch signed URLs at
   *  compile time); this map carries local file paths for embeddable images. */
  attachments: Map<string, ResolvedAttachment>
  /** attachId -> absolute local path of a downloaded image the compiler can read.
   *  Populated by the route when it has streamed the object-store bytes to a temp
   *  file inside the compile root. Absent => image node is dropped (same as an
   *  unresolved attachment on the HTML path). */
  imagePaths?: Map<string, string>
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
/** Clamp a user-controlled numeric attr to sane bounds before use in loops. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

// ── escaping ─────────────────────────────────────────────────────────────────
/**
 * Escape a JS string for embedding inside a Typst double-quoted string literal.
 * Only backslash and double-quote are special in a Typst string.
 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Escape text for Typst MARKUP context (outside a string literal). Typst markup
 * has many special chars (* _ ` # $ [ ] @ < > \\ etc). We backslash-escape the
 * ones that would otherwise start markup so authored text renders literally.
 */
function escContent(s: string): string {
  const escaped = s.replace(/([\\#*_`$\[\]@<>~])/g, '\\$1')
  // Typst collapses runs of ASCII spaces in markup, dropping intentional spacing
  // like first-line indentation or aligned gaps. Convert every run of 2+ spaces
  // (and any leading space) to non-breaking spaces (U+00A0), which Typst keeps
  // verbatim, so authored spacing survives export. Single interior spaces stay
  // ordinary so normal line breaking still works.
  return escaped
    .replace(/^ +/gm, (m) => '\u00A0'.repeat(m.length))
    .replace(/ {2,}/g, (m) => '\u00A0'.repeat(m.length))
}

// ── URL / CSS whitelists (shared policy with the HTML path) ────────────────────
function isSafeHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/)
  if (!scheme) return true
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1] ?? '')
}

function isSafeCssColor(v: string): boolean {
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{3,8}$/.test(s)) return true
  if (/^rgba?\(\s*[\d.%,\s/]+\)$/.test(s)) return true
  if (/^hsla?\(\s*[\d.%,\s/deg]+\)$/.test(s)) return true
  if (/^[a-z]+$/.test(s)) return true
  return false
}

/**
 * Map a whitelisted CSS colour to a Typst colour expression. Typst accepts
 * `rgb("#rrggbb")` for hex and named CSS colours via `rgb(...)`; for hex we
 * pass the string form, for simple names we use rgb() with the name only if it
 * is a known Typst colour, else fall back to black (never inject raw).
 */
function cssColorToTypst(v: string): string | null {
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{3,8}$/.test(s)) return `rgb("${s}")`
  // rgb()/rgba() → Typst rgb() takes the same numeric form via a string is not
  // supported, so parse simple rgb(r,g,b) into components.
  const m = s.match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/)
  if (m) {
    const r = clampInt(m[1], 0, 255, 0)
    const g = clampInt(m[2], 0, 255, 0)
    const b = clampInt(m[3], 0, 255, 0)
    return `rgb(${r}, ${g}, ${b})`
  }
  // Named colours that exist in both CSS and Typst's default palette.
  const NAMED = new Set([
    'black', 'gray', 'silver', 'white', 'navy', 'blue', 'aqua', 'teal',
    'green', 'olive', 'lime', 'yellow', 'orange', 'red', 'maroon', 'fuchsia', 'purple',
  ])
  if (NAMED.has(s)) return s
  return null
}

/** Whitelisted CSS font-size -> Typst length string (pt). Returns null if unsafe. */
function cssFontSizeToTypst(v: string): string | null {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)(px|pt|em|rem|%)?$/)
  if (!m) return null
  const num = parseFloat(m[1]!)
  const unit = m[2] ?? 'px'
  if (!Number.isFinite(num) || num <= 0) return null
  switch (unit) {
    case 'pt':
      return `${num}pt`
    case 'px':
      // CSS px -> pt at 96dpi: 1px = 0.75pt
      return `${(num * 0.75).toFixed(2)}pt`
    case 'em':
    case 'rem':
      return `${num}em`
    case '%':
      return `${num / 100}em`
    default:
      return null
  }
}

// ── LaTeX -> Typst math conversion ────────────────────────────────────
/**
 * Convert a LaTeX math expression to Typst math syntax. Typst native math uses
 * a DIFFERENT surface syntax from LaTeX (`\frac{a}{b}` -> `frac(a, b)`,
 * `\alpha` -> `alpha`, `x^{2}` -> `x^(2)`). This covers the common constructs
 * the editor emits (KaTeX-authored formulas). Unmappable input is passed through
 * best-effort; if the compile still fails, the caller's per-formula fallback
 * (verbatim source span) keeps content visible instead of crashing the doc.
 *
 * Deliberately a pragmatic subset, not a full LaTeX parser. Typst math mode is
 * forgiving (bare idents, ^, _, paren grouping all work), so most real formulas
 * convert cleanly.
 */
const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi',
  'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi',
  'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma',
  'Upsilon', 'Phi', 'Psi', 'Omega',
])

// LaTeX command -> Typst symbol name (only those that differ or need pinning).
const LATEX_CMD_TO_TYPST: Record<string, string> = {
  times: 'times', div: 'div', pm: 'plus.minus', mp: 'minus.plus',
  cdot: 'dot.op', cdots: 'dots.c', ldots: 'dots.h', dots: 'dots.h', vdots: 'dots.v', ddots: 'dots.down',
  leq: 'lt.eq', le: 'lt.eq', geq: 'gt.eq', ge: 'gt.eq', neq: 'eq.not', ne: 'eq.not',
  approx: 'approx', equiv: 'equiv', sim: 'tilde.op', propto: 'prop',
  infty: 'infinity', partial: 'diff', nabla: 'nabla',
  rightarrow: 'arrow.r', to: 'arrow.r', leftarrow: 'arrow.l', Rightarrow: 'arrow.r.double',
  Leftarrow: 'arrow.l.double', leftrightarrow: 'arrow.l.r', mapsto: 'arrow.r.bar',
  forall: 'forall', exists: 'exists', in: 'in', notin: 'in.not', subset: 'subset',
  subseteq: 'subset.eq', supset: 'supset', supseteq: 'supset.eq', cup: 'union', cap: 'sect',
  emptyset: 'nothing', varnothing: 'nothing', setminus: 'without',
  sum: 'sum', prod: 'product', int: 'integral', iint: 'integral.double', oint: 'integral.cont',
  lim: 'lim', log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  sec: 'sec', csc: 'csc', cot: 'cot', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', det: 'det', gcd: 'gcd', deg: 'deg',
  max: 'max', min: 'min', sup: 'sup', inf: 'inf', arg: 'arg', dim: 'dim', ker: 'ker',
  angle: 'angle', perp: 'perp', parallel: 'parallel', cong: 'tilde.equiv',
  langle: 'angle.l', rangle: 'angle.r', lfloor: 'floor.l', rfloor: 'floor.r',
  lceil: 'ceil.l', rceil: 'ceil.r', wedge: 'and', vee: 'or', neg: 'not',
  oplus: 'plus.circle', otimes: 'times.circle', star: 'star.op', ast: 'ast.op',
  circ: 'compose', bullet: 'bullet', dagger: 'dagger', prime: 'prime',
  Re: 'Re', Im: 'Im', aleph: 'aleph', hbar: 'planck.reduce', ell: 'ell',
  quad: 'quad', qquad: 'wide',
}

/** Chars special in Typst math that must be escaped to render literally. */
function escMathLiteral(c: string): string {
  if (c === '#' || c === '$' || c === '"') return `\\${c}`
  if (c === '&') return '' // alignment tab — drop
  return c
}

/**
 * Scan a LaTeX math string and translate `\cmd`, `^`/`_` scripts, `{...}`
 * groups, and multi-arg constructs (frac/sqrt/binom/text) into Typst math.
 * Pure function: creates its own cursor so nested calls don't share state.
 */
function latexToTypstMath(latex: string): string {
  let i = 0
  const src = latex
  const len = src.length

  function readBraceGroup(): string {
    if (src[i] !== '{') return ''
    i++
    let depth = 1
    const start = i
    while (i < len && depth > 0) {
      if (src[i] === '\\') { i += 2; continue }
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) break }
      i++
    }
    const inner = src.slice(start, i)
    if (src[i] === '}') i++
    return latexToTypstMath(inner)
  }

  /**
   * Read a MULTI-CHAR argument for a construct that supplies its own grouping
   * (frac/root/binom accessories/decorations). Returns the converted content
   * WITHOUT wrapping parens, because the caller emits `name(arg, ...)` where the
   * parens are Typst function-call syntax (invisible), not math parens. A bare
   * `{...}` group therefore must NOT become a visible `(...)`.
   */
  function readGroupArg(): string {
    while (i < len && /\s/.test(src[i]!)) i++
    if (src[i] === '{') return readBraceGroup()
    if (src[i] === '\\') return readCommand()
    const ch = src[i]
    i++
    return ch ?? ''
  }

  /**
   * Read a SCRIPT argument (after ^ or _). Here grouping DOES need parens so
   * `x^{2n}` -> `x^(2n)` binds correctly; a single token stays bare (`x^2`).
   */
  function readArg(): string {
    while (i < len && /\s/.test(src[i]!)) i++
    if (src[i] === '{') {
      const inner = readBraceGroup()
      // Single atom needs no parens; multi-atom does to bind the whole script.
      return /^[\w.]$/.test(inner) ? inner : `(${inner})`
    }
    if (src[i] === '\\') return readCommand()
    const ch = src[i]
    i++
    return ch ?? ''
  }

  /**
   * Emit a single-arg Typst function only when the arg is non-empty. A missing
   * arg (e.g. `\hat` at end of input, or `\bar{}`) would otherwise produce
   * `name()` which Typst rejects with "missing argument: body". Empty => drop.
   */
  function decorate(fn: string, arg: string): string {
    return arg.trim().length ? `${fn}(${arg})` : ''
  }

  function readCommand(): string {
    i++ // skip backslash
    if (i < len && !/[a-zA-Z]/.test(src[i]!)) {
      const c = src[i]!
      i++
      if (c === ',' || c === ';' || c === ' ' || c === '!' || c === ':') return ' '
      if (c === '\\') return '\\ '
      if (c === '{' || c === '}') return c
      return escMathLiteral(c)
    }
    let name = ''
    while (i < len && /[a-zA-Z]/.test(src[i]!)) { name += src[i]; i++ }
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac': {
        const a = readGroupArg(); const b = readGroupArg()
        // Empty numerator/denominator would make Typst's frac() error; substitute
        // a zero-width placeholder so the fraction still renders.
        return `frac(${a.trim() || "zws"}, ${b.trim() || "zws"})`
      }
      case 'sqrt': {
        while (i < len && /\s/.test(src[i]!)) i++
        if (src[i] === '[') {
          const s2 = i + 1
          while (i < len && src[i] !== ']') i++
          const idx = latexToTypstMath(src.slice(s2, i))
          if (src[i] === ']') i++
          return `root(${idx.trim() || 'zws'}, ${readGroupArg().trim() || 'zws'})`
        }
        return `sqrt(${readGroupArg().trim() || 'zws'})`
      }
      case 'binom': {
        const a = readGroupArg(); const b = readGroupArg()
        return `binom(${a.trim() || 'zws'}, ${b.trim() || 'zws'})`
      }
      case 'text':
      case 'mathrm':
      case 'operatorname': {
        while (i < len && /\s/.test(src[i]!)) i++
        if (src[i] === '{') {
          i++
          let depth = 1; const s2 = i
          while (i < len && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') { depth--; if (depth === 0) break }
            i++
          }
          const t = src.slice(s2, i)
          if (src[i] === '}') i++
          return `"${esc(t)}"`
        }
        return ''
      }
      case 'left':
      case 'right': {
        const d = src[i]; i++
        if (d === '.') return ''
        if (d === '\\') return readCommand()
        return d ?? ''
      }
      case 'hat': return decorate('hat', readGroupArg())
      case 'bar':
      case 'overline': return decorate('overline', readGroupArg())
      case 'vec': return decorate('arrow', readGroupArg())
      case 'dot': return decorate('dot', readGroupArg())
      case 'ddot': return decorate('dot.double', readGroupArg())
      case 'tilde': return decorate('tilde', readGroupArg())
      case 'boldsymbol':
      case 'mathbf': return decorate('bold', readGroupArg())
      case 'mathbb': return decorate('bb', readGroupArg())
      case 'mathcal': return decorate('cal', readGroupArg())
      case 'mathfrak': return decorate('frak', readGroupArg())
      case 'begin':
      case 'end': {
        while (i < len && /\s/.test(src[i]!)) i++
        if (src[i] === '{') { while (i < len && src[i] !== '}') i++; if (src[i] === '}') i++ }
        return ''
      }
      default: {
        if (GREEK.has(name)) return name
        const mapped = LATEX_CMD_TO_TYPST[name]
        if (mapped) return mapped
        // Unknown command. A bare multi-letter identifier in Typst math is an
        // ERROR (unknown variable), so emit it as an upright text string, which
        // always compiles and preserves the source legibly. Single letters are
        // valid math idents, so pass those through bare.
        if (name.length === 1) return name
        return `"${esc(name)}"`
      }
    }
  }

  let out = ''
  while (i < len) {
    const ch = src[i]!
    if (ch === '\\') { out += readCommand(); continue }
    if (ch === '{') { out += readBraceGroup(); continue }
    if (ch === '^' || ch === '_') { out += ch; i++; out += readArg(); continue }
    if (ch === '&') { i++; continue }
    if (ch === '~') { out += ' '; i++; continue }
    if (ch === '%') { while (i < len && src[i] !== '\n') i++; continue }
    // Consecutive ASCII letters: Typst reads a multi-letter run (e.g. `dx`,
    // `abc`) as ONE unknown variable and errors. LaTeX renders each letter as a
    // separate italic variable, so split the run with spaces to match and stay
    // compilable. Single letters and digit runs pass through unchanged.
    if (/[a-zA-Z]/.test(ch)) {
      const letters: string[] = []
      while (i < len && /[a-zA-Z]/.test(src[i]!)) { letters.push(src[i]!); i++ }
      out += letters.join(letters.length > 1 ? ' ' : '')
      continue
    }
    out += escMathLiteral(ch)
    i++
  }
  return out
}

// ── emoji ────────────────────────────────────────────────────────────────────
// emoji name/shortcode -> unicode glyph, from the SAME set the editor/frontend
// use (matches the HTML/DOCX export). Keeps backend PDF emoji identical to what
// the user authored.
const EMOJI_GLYPH_BY_KEY: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const e of gitHubEmojis) {
    if (!e.emoji) continue
    m.set(e.name, e.emoji)
    for (const sc of e.shortcodes ?? []) m.set(sc, e.emoji)
  }
  return m
})()

// ── inline marks ───────────────────────────────────────────────────────────
/**
 * Wrap already-converted inner Typst markup with one mark's Typst function.
 * The first mark in the array is the innermost wrapper (same order as the HTML
 * path). Wrappers use Typst content blocks `[...]` so inner markup stays markup,
 * and `esc()`d strings for user-controlled attrs.
 */
function wrapMark(mark: PMMark, inner: string): string {
  const attrs = mark.attrs ?? {}
  switch (mark.type) {
    case 'bold':
      // Explicit heavy weight. CJK fonts often ship a single weight, so #strong
      // alone can look weak; force weight so bold is unmistakable across fonts.
      return `#text(weight: "bold")[${inner}]`
    case 'italic':
      // CJK fonts rarely have an italic/oblique cut, so #emph / style:"italic"
      // leaves Chinese upright. Synthesize a slant with skew so CJK visibly
      // italicizes; Latin still gets the proper italic via emph inside.
      return `#box(skew(ax: -12deg)[#emph[${inner}]])`
    case 'underline':
      return `#underline[${inner}]`
    case 'strike':
      return `#strike[${inner}]`
    case 'code':
      // Inline code chip: light-grey rounded box matching the editor (#eff1f3).
      // `inner` is markup-escaped (escContent added backslashes / nbsp); #raw()
      // wants the LITERAL text, so undo the markup escaping and normalise the
      // nbsp we use for spacing back to plain spaces, then string-escape it.
      return `#box(fill: rgb("#eff1f3"), inset: (x: 3pt, y: 0pt), outset: (y: 3pt), radius: 2pt)[#raw("${esc(unescapeContent(inner))}")]`
    case 'superscript':
      return `#super[${inner}]`
    case 'subscript':
      return `#sub[${inner}]`
    case 'highlight': {
      const color = attrs.color != null ? String(attrs.color) : null
      const typ = color && isSafeCssColor(color) ? cssColorToTypst(color) : null
      return typ ? `#highlight(fill: ${typ})[${inner}]` : `#highlight[${inner}]`
    }
    case 'textStyle': {
      const args: string[] = []
      if (attrs.color != null && isSafeCssColor(String(attrs.color))) {
        const typ = cssColorToTypst(String(attrs.color))
        if (typ) args.push(`fill: ${typ}`)
      }
      if (attrs.fontSize != null) {
        const sz = cssFontSizeToTypst(String(attrs.fontSize))
        if (sz) args.push(`size: ${sz}`)
      }
      return args.length ? `#text(${args.join(', ')})[${inner}]` : inner
    }
    case 'link': {
      const href = attrs.href != null ? String(attrs.href) : null
      if (!href || !isSafeHref(href)) return inner
      return `#link("${esc(href)}")[${inner}]`
    }
    default:
      return inner
  }
}

/** Strip our own Typst markup wrappers for a raw() argument, which needs plain
 *  text. code is a leaf mark on text, so in practice inner is already escaped
 *  literal text; this only unwraps if a wrapper slipped in. */
/**
 * Reverse escContent(): drop the backslashes it added before Typst markup chars
 * and turn the non-breaking spaces we use for spacing back into plain spaces.
 * Used to recover literal text before putting it inside #raw("...").
 */
function unescapeContent(s: string): string {
  return s.replace(/\\([\\#*_`$\[\]@<>~])/g, '$1').replace(/\u00A0/g, ' ')
}

function renderTextNode(node: PMNode): string {
  let out = escContent(node.text ?? '')
  // Apply the `code` mark innermost so it wraps the PLAIN text; other marks
  // (bold/italic/color/...) then wrap the resulting code chip. Without this,
  // a bold+code run would feed already-generated Typst markup like
  // `#text(weight:"bold")[x]` into #raw(), leaking source into the output.
  const marks = [...(node.marks ?? [])].sort((a, b) => {
    const ca = a.type === 'code' ? 0 : 1
    const cb = b.type === 'code' ? 0 : 1
    return ca - cb
  })
  for (const mark of marks) out = wrapMark(mark, out)
  return out
}

// ── block / inline nodes ───────────────────────────────────────────────────────
const VALID_TEXT_ALIGNS = new Set(['left', 'right', 'center', 'justify'])
const MAX_RENDER_DEPTH = 200

interface RenderCtx {
  attachments: Map<string, ResolvedAttachment>
  imagePaths: Map<string, string>
  depth: number
}

function alignArg(attrs: Record<string, unknown> | undefined): string {
  const a = attrs?.textAlign as string | null | undefined
  if (!a || !VALID_TEXT_ALIGNS.has(a)) return ''
  return a === 'justify' ? '' : a // justify handled via par(justify) globally; l/r/c map directly
}

function renderChildren(node: PMNode, ctx: RenderCtx): string {
  return (node.content ?? []).map((c) => renderNode(c, ctx)).join('')
}

const CALLOUT_ICON: Record<string, string> = {
  info: 'ℹ️', warn: '⚠️', tip: '💡', success: '✅',
}
const CALLOUT_FILL: Record<string, string> = {
  // Match the editor/HTML callout palette (rgba over white flattened to hex):
  // info=blue, warn=orange, tip=green, success=green. Previously tip was purple.
  info: 'rgb("#eaf0ff")', warn: 'rgb("#fef3e6")', tip: 'rgb("#e6f7ea")', success: 'rgb("#daf2e1")',
}
const CALLOUT_STROKE: Record<string, string> = {
  info: 'rgb("#c2d3ff")', warn: 'rgb("#f7c98e")', tip: 'rgb("#b3e6c0")', success: 'rgb("#99dcac")',
}

/** Emit a Typst image() for a resolved+downloaded attachment, else nothing. */
function renderImage(node: PMNode, ctx: RenderCtx): string {
  const attrs = node.attrs ?? {}
  const attachId = attrs.attachId as string | null
  if (!attachId) return ''
  const meta = ctx.attachments.get(attachId)
  const path = ctx.imagePaths.get(attachId)
  // Only render if we have a locally readable image file AND it's an image mime.
  if (!path) return ''
  if (meta?.mime && !meta.mime.startsWith('image/')) return ''
  const width = attrs.width != null ? String(attrs.width) : null
  const m = width && /^(\d+(?:\.\d+)?)(px|%)?$/.exec(width)
  if (m) {
    const num = parseFloat(m[1]!)
    if (Number.isFinite(num) && num > 0) {
      // Explicit width, but never let it exceed the content width.
      const w = m[2] === '%' ? `${Math.min(num, 100)}%` : `${(num * 0.75).toFixed(1)}pt`
      return `\n#figure(__capImage("${esc(path)}", w: ${w}))\n`
    }
  }
  // No explicit width: cap to the page content width so large images don't
  // overflow, but don't upscale small ones (max-width: 100% behavior).
  return `\n#figure(__capImage("${esc(path)}"))\n`
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function renderFileAttachment(node: PMNode, ctx: RenderCtx): string {
  const attrs = node.attrs ?? {}
  const attachId = attrs.attachId as string | null
  const resolved = attachId ? ctx.attachments.get(attachId) : undefined
  const fileName = escContent(String(attrs.fileName ?? resolved?.fileName ?? 'file'))
  const size = humanSize(Number(attrs.sizeBytes ?? resolved?.sizeBytes ?? 0))
  const meta = size ? ` #text(size: 8pt, fill: gray)[${escContent(size)}]` : ''
  return `\n#block(fill: rgb("#f5f5f5"), inset: 8pt, radius: 4pt, width: 100%)[\\u{1F4CE} ${fileName}${meta}]\n`
}

function renderBookmark(node: PMNode): string {
  const attrs = node.attrs ?? {}
  const url = attrs.url != null ? String(attrs.url) : null
  const title = escContent(String(attrs.title ?? url ?? ''))
  const description = attrs.description ? escContent(String(attrs.description)) : ''
  const siteName = attrs.siteName ? escContent(String(attrs.siteName)) : ''
  const urlLine = url ? `\\ #text(size: 8pt, fill: gray)[${siteName ? siteName + ' · ' : ''}${escContent(url)}]` : ''
  const descLine = description ? `\\ #text(size: 9pt)[${description}]` : ''
  return `\n#block(stroke: 0.5pt + gray, inset: 8pt, radius: 4pt, width: 100%)[#strong[${title}]${descLine}${urlLine}]\n`
}

function renderNode(node: PMNode, ctx: RenderCtx): string {
  const depth = ctx.depth + 1
  if (depth > MAX_RENDER_DEPTH) return ''
  const attrs = node.attrs ?? {}
  const c: RenderCtx = { ...ctx, depth }
  switch (node.type) {
    case 'text':
      return renderTextNode(node)
    case 'paragraph': {
      const body = renderChildren(node, c)
      const al = alignArg(attrs)
      const inner = al ? `#align(${al})[${body}]` : body
      return `\n${inner}\n`
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs.level ?? 1)))
      return `\n${'='.repeat(level)} ${renderChildren(node, c)}\n`
    }
    case 'bulletList':
      return `\n${renderListItems(node, c, '-')}\n`
    case 'orderedList': {
      const start = clampInt(attrs.start, 1, 99999, 1)
      return `\n${renderListItems(node, c, '+', start)}\n`
    }
    case 'listItem':
      // Handled by renderListItems; standalone fallback.
      return renderChildren(node, c)
    case 'taskList':
      return `\n${renderTaskItems(node, c)}\n`
    case 'taskItem': {
      const box = attrs.checked ? '☑' : '☐'
      return `${box} ${renderChildren(node, c)}`
    }
    case 'blockquote':
      // Match the editor: #f6f8fa fill, #d0d7de left bar, muted #57606a text.
      return `\n#block(fill: rgb("#f6f8fa"), stroke: (left: 3pt + rgb("#d0d7de")), inset: (left: 12pt, top: 8pt, bottom: 8pt, right: 8pt), width: 100%)[#text(fill: rgb("#57606a"))[${renderChildren(node, c)}]]\n`
    case 'codeBlock': {
      const text = collectText(node)
      const lang = attrs.language != null ? String(attrs.language) : ''
      const safeLang = /^[a-zA-Z0-9_+-]{0,20}$/.test(lang) ? lang : ''
      // Fenced raw gives Typst native SYNTAX HIGHLIGHTING when a known language
      // is set. Wrap it in a rounded block with the editor's code background
      // (#f6f8fa). Escaping: choose a fence longer than any backtick run inside.
      const maxTicks = Math.max(0, ...(text.match(/`+/g) ?? []).map((s) => s.length))
      const fence = '`'.repeat(Math.max(3, maxTicks + 1))
      const raw = `${fence}${safeLang}\n${text}\n${fence}`
      return `\n#block(fill: rgb("#f6f8fa"), inset: 10pt, radius: 6pt, width: 100%)[\n${raw}\n]\n`
    }
    case 'horizontalRule':
      return '\n#line(length: 100%, stroke: 0.5pt + gray)\n'
    case 'hardBreak':
      return ' \\ '
    case 'image':
      return renderImage(node, c)
    case 'table':
      return renderTable(node, c)
    case 'tableRow':
    case 'tableCell':
    case 'tableHeader':
      // Cells are emitted by renderTable; never reached standalone.
      return renderChildren(node, c)
    case 'emoji': {
      const name = attrs.name as string | null
      if (!name) return ''
      const glyph = EMOJI_GLYPH_BY_KEY.get(name)
      return glyph ? escContent(glyph) : escContent(`:${name}:`)
    }
    case 'mention': {
      const label = attrs.label != null ? String(attrs.label) : ''
      const char = (attrs.mentionSuggestionChar as string) || '@'
      return `#box(fill: rgb("#ddf4ff"), inset: (x: 2pt), outset: (y: 2pt), radius: 2pt)[#text(fill: rgb("#0969da"))[${escContent(char + label)}]]`
    }
    case 'details':
      return `\n#block(stroke: (left: 2pt + gray), inset: (left: 8pt))[${renderChildren(node, c)}]\n`
    case 'detailsSummary':
      return `#strong[${renderChildren(node, c)}]\\ `
    case 'detailsContent':
      return renderChildren(node, c)
    case 'callout': {
      const variant = (attrs.variant as string) || 'info'
      const icon = CALLOUT_ICON[variant] ?? CALLOUT_ICON.info
      const fill = CALLOUT_FILL[variant] ?? CALLOUT_FILL.info
      const stroke = CALLOUT_STROKE[variant] ?? CALLOUT_STROKE.info
      return `\n#block(fill: ${fill}, stroke: 0.5pt + ${stroke}, inset: 10pt, radius: 4pt, width: 100%)[${escContent(icon!)} ${renderChildren(node, c)}]\n`
    }
    case 'inlineMath': {
      const converted = safeMath(String(attrs.latex ?? ''))
      return `$${converted}$`
    }
    case 'blockMath': {
      const converted = safeMath(String(attrs.latex ?? ''))
      return `\n$ ${converted} $\n`
    }
    case 'fileAttachment':
      return renderFileAttachment(node, c)
    case 'bookmark':
      return renderBookmark(node)
    default:
      return renderChildren(node, c)
  }
}

/** Convert LaTeX->Typst math; on any converter throw, fall back to a quoted
 *  verbatim source so the formula is still visible (never crashes the doc). */
function safeMath(latex: string): string {
  try {
    const t = latexToTypstMath(latex).trim()
    return t.length ? t : `"${esc(latex)}"`
  } catch {
    return `"${esc(latex)}"`
  }
}

/** Collect only the plain text of a node's descendants (for code blocks). */
function collectText(node: PMNode): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(collectText).join('')
}

/**
 * Render a bullet/ordered list using Typst's #list(...) / #enum(...) CONTENT
 * functions (not the line-oriented `- item` markup). Each item's rendered
 * content goes in its own `[...]` argument, so nested lists and multi-paragraph
 * items are preserved correctly instead of being flattened onto one line.
 */
function renderListItems(node: PMNode, ctx: RenderCtx, marker: string, start = 1): string {
  const items = (node.content ?? []).filter((n) => n.type === 'listItem')
  const args = items.map((item) => `[${renderChildren(item, ctx).trim()}]`).join(', ')
  if (marker === '+') {
    const startArg = start !== 1 ? `start: ${start}, ` : ''
    return `#enum(${startArg}${args})`
  }
  return `#list(${args})`
}

function renderTaskItems(node: PMNode, ctx: RenderCtx): string {
  const items = (node.content ?? []).filter((n) => n.type === 'taskItem')
  // Task items are rendered as a marker-less list where each item carries its
  // own checkbox glyph, so nested content and wrapping are preserved.
  const args = items.map((item) => {
    const box = item.attrs?.checked ? '☑' : '☐'
    return `[#box[${box}] ${renderChildren(item, ctx).trim()}]`
  }).join(', ')
  return `#list(marker: none, ${args})`
}

/**
 * Render a ProseMirror table as a Typst #table(). Column count is derived from
 * the first row's cells (expanding colspans). colspan/rowspan map to Typst's
 * table.cell(colspan:, rowspan:). Header row gets a subtle fill.
 */
function renderTable(node: PMNode, ctx: RenderCtx): string {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow')
  if (rows.length === 0) return ''
  // Column count from the first row (expand colspans).
  let cols = 0
  for (const cell of rows[0]!.content ?? []) {
    cols += clampInt(cell.attrs?.colspan, 1, 100, 1)
  }
  if (cols === 0) cols = 1

  // Column WIDTHS from the first row's cell `colwidth` attrs (px), so exported
  // columns match the editor. Each cell's colwidth is an array (length=colspan)
  // of px widths or null. Walk the first row expanding colspans to collect one
  // width per column; a column with no explicit width becomes `auto` (Typst
  // distributes remaining space). If NO column has a width we omit the widths
  // arg entirely and let Typst auto-size (same as the HTML path's behavior).
  const widths: (number | null)[] = []
  for (const cell of rows[0]!.content ?? []) {
    const a = cell.attrs ?? {}
    const colspan = clampInt(a.colspan, 1, 100, 1)
    const cw = Array.isArray(a.colwidth) ? (a.colwidth as unknown[]) : null
    for (let k = 0; k < colspan; k++) {
      const raw = cw ? cw[k] : null
      const w = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null
      widths.push(w)
    }
  }
  const hasWidths = widths.some((w) => w != null)
  // px -> pt (0.75) for set widths; unset columns get 1fr so they share the
  // rest proportionally rather than collapsing.
  const columnsArg = hasWidths
    ? `(${widths.map((w) => (w != null ? `${(w * 0.75).toFixed(1)}pt` : '1fr')).join(', ')})`
    : `(${Array.from({ length: cols }, () => '1fr').join(', ')})`

  // Determine if the first row is a pure header row (all tableHeader cells). If
  // so, emit it inside table.header(...) so Typst REPEATS it on every page the
  // table spans (fixes "table across pages has no header").
  const first = rows[0]!
  const firstIsHeader =
    (first.content ?? []).length > 0 &&
    (first.content ?? []).every((cl) => cl.type === 'tableHeader')

  const renderCell = (cell: PMNode): string => {
    const a = cell.attrs ?? {}
    const colspan = clampInt(a.colspan, 1, 100, 1)
    const rowspan = clampInt(a.rowspan, 1, 100, 1)
    const isHeader = cell.type === 'tableHeader'
    const body = renderChildren(cell, ctx).trim() || ' '
    const content = isHeader ? `#text(weight: "bold")[${body}]` : body
    const spanArgs: string[] = []
    if (colspan !== 1) spanArgs.push(`colspan: ${colspan}`)
    if (rowspan !== 1) spanArgs.push(`rowspan: ${rowspan}`)
    return spanArgs.length ? `table.cell(${spanArgs.join(', ')})[${content}]` : `[${content}]`
  }

  const parts: string[] = []
  if (firstIsHeader) {
    const headerCells = (first.content ?? []).map(renderCell).join(', ')
    parts.push(`table.header(${headerCells})`)
    for (const row of rows.slice(1)) {
      for (const cell of row.content ?? []) parts.push(renderCell(cell))
    }
  } else {
    for (const row of rows) {
      for (const cell of row.content ?? []) parts.push(renderCell(cell))
    }
  }

  // Header rows get a subtle fill via a fill function keyed on the header rows.
  const fillArg = firstIsHeader
    ? `\n  fill: (_, row) => if row == 0 { rgb("#f6f8fa") },`
    : ''
  return `\n#table(\n  columns: ${columnsArg},\n  stroke: 0.5pt + rgb("#d0d7de"),\n  inset: 7pt,${fillArg}\n  ${parts.join(',\n  ')}\n)\n`
}

// ── document assembly ─────────────────────────────────────────────────────────
/**
 * The Typst document preamble: A4 page, CJK-first font stack, heading/link
 * styling, justified paragraphs. Fonts are resolved by the `typst` binary from
 * the system font book (macOS: PingFang SC; Linux container: Noto Sans CJK SC,
 * installed in the image). The stack lists several so it works across hosts.
 */
function preamble(title: string): string {
  return [
    '#set page(paper: "a4", margin: (x: 16mm, y: 18mm))',
    '#set text(',
    // CJK-first stack, with an emoji font appended so emoji nodes and callout
    // icons (ℹ️⚠️💡✅) render in colour. macOS: Apple Color Emoji; Linux image:
    // Noto Color Emoji (installed in the Dockerfile).
    '  font: ("Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Noto Sans", "Helvetica Neue", "Arial", "Noto Color Emoji", "Apple Color Emoji"),',
    '  size: 11pt,',
    '  lang: "zh",',
    ')',
    // Body line spacing matched to the editor's line-height: 1.7. Typst `leading`
    // is the gap BETWEEN lines, so 0.85em on 11pt yields ~1.7 line-height
    // (measured), fixing the too-cramped look versus the browser export.
    '#set par(justify: true, leading: 0.85em, spacing: 0.9em, first-line-indent: 0pt)',
    '#show heading: set block(above: 1.2em, below: 0.6em)',
    '#show link: set text(fill: rgb("#0969da"))',
    '#set table(align: left + horizon)',
    // Image max-width helper: cap to the page CONTENT width so large images
    // never overflow, but keep small images at natural size (no upscaling),
    // matching the editor/HTML `max-width: 100%; height: auto`. An optional
    // explicit width is applied but still bounded by the content width.
    '#let __capImage(path, w: none) = context {',
    '  let avail = page.width - 32mm',
    '  let nat = measure(image(path))',
    '  if w != none {',
    '    let target = if type(w) == length and w > avail { avail } else { w }',
    '    image(path, width: target)',
    '  } else if nat.width > avail {',
    '    image(path, width: 100%)',
    '  } else {',
    '    image(path)',
    '  }',
    '}',
    `#set document(title: "${esc(title)}")`,
    '',
    // Leading H1 = document title (mirrors the HTML path).
    `= ${escContent(title)}`,
    '',
  ].join('\n')
}

export interface RenderTypstResult {
  /** The Typst source to compile. */
  source: string
}

/**
 * Convert a ProseMirror document JSON to a complete Typst source string.
 * Pure and synchronous. The caller compiles the returned
 * source with the `typst` binary (see typstService).
 */
export function renderTypst(pmJson: unknown, opts: RenderTypstOptions): string {
  const doc = pmJson as PMNode
  const ctx: RenderCtx = {
    attachments: opts.attachments,
    imagePaths: opts.imagePaths ?? new Map(),
    depth: 0,
  }
  const body = (doc?.content ?? []).map((n) => renderNode(n, ctx)).join('')
  return `${preamble(opts.title)}\n${body}\n`
}

// Exposed for unit tests only.
export const __test = { latexToTypstMath, wrapMark, cssColorToTypst, cssFontSizeToTypst, isSafeHref, renderTypstNode: renderNode, renderTextNode }
