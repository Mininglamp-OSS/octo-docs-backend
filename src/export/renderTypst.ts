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
  /** Math rendering mode. 'convert' (default) translates LaTeX -> Typst math;
   *  'verbatim' emits the raw LaTeX as a quoted string instead. The route uses
   *  'verbatim' as a whole-document retry when a 'convert' pass fails to
   *  compile, so one malformed formula degrades to visible source text rather
   *  than 500-ing the entire export. */
  mathMode?: 'convert' | 'verbatim'
  /** Per-formula verbatim set (raw LaTeX strings). When present, a formula whose
   *  `latex` is in this set renders verbatim (quoted source) while every other
   *  formula still converts normally. The route builds this set by probing each
   *  unique formula after a whole-document compile failure, so ONE malformed
   *  formula degrades to source text and the REST of the document still renders
   *  as real math (instead of the whole doc dropping to verbatim). */
  verbatimFormulas?: Set<string>
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
  // Escape every char that can start/alter Typst markup so authored text renders
  // literally. Beyond the obvious markup chars, this includes:
  //   `/`  — `//` starts a line comment (and `/*` a block comment) in markup, so
  //          prose like "roadmap // Q3" or a URL used as link text would either
  //          drop trailing text or comment out a closing `]`/`)` and fail the
  //          whole compile. Escaping every `/` neutralises the comment triggers.
  //   `= + -` — at column 0 these start a heading / list item; block emitters put
  //          user text at line start, so escape them everywhere (mid-line a
  //          backslash-escaped `=`/`+`/`-` still renders as the literal char).
  const escaped = s.replace(/([\\#*_`$[\]@<>~/=+-])/g, '\\$1')
  // Typst collapses runs of ASCII spaces in markup, dropping intentional spacing
  // like first-line indentation or aligned gaps. Convert every run of 2+ spaces
  // (and any leading space) to non-breaking spaces (U+00A0), which Typst keeps
  // verbatim, so authored spacing survives export. Single interior spaces stay
  // ordinary so normal line breaking still works.
  return escaped
    .replace(/^ +/gm, (m) => '\u00A0'.repeat(m.length))
    .replace(/ {2,}/g, (m) => '\u00A0'.repeat(m.length))
    // Long unbroken non-space runs (e.g. a 100-char `aaaa...` or a long URL used
    // as link text) won't break in justified paragraphs and overflow the right
    // margin. Insert zero-width break opportunities (U+200B) every 20 chars into
    // any run of 40+ non-space characters so Typst can wrap it. CJK already
    // breaks per-glyph, so this only meaningfully affects long Latin/symbol runs.
    .replace(/\S{40,}/g, (run) => run.replace(/(.{20})/g, '$1\u200B'))
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

/**
 * Map a LaTeX colour argument (from `\color{...}` / `\textcolor{...}`) to a
 * Typst colour expression, or null when unsafe/unknown so the caller renders
 * uncoloured instead of injecting raw text. Accepts named colours and hex; the
 * hex `#` may arrive backslash-escaped from the math tokenizer, so strip a
 * leading `\` first. LaTeX-only names not in Typst's palette map to a close
 * Typst equivalent.
 */
function mathColorArgToTypst(arg: string): string | null {
  let s = arg.trim().replace(/^\\/, '')
  // A hex value may have been escaped to `\#rrggbb` by escMathLiteral.
  s = s.replace(/^\\?#/, '#').toLowerCase()
  if (/^#[0-9a-f]{3,8}$/.test(s)) return `rgb("${s}")`
  // LaTeX/xcolor names that are not Typst palette names -> nearest Typst colour.
  const ALIAS: Record<string, string> = {
    cyan: 'aqua',
    magenta: 'fuchsia',
    violet: 'purple',
    pink: 'rgb("#ffc0cb")',
    brown: 'rgb("#a52a2a")',
    darkgray: 'rgb("#a9a9a9")',
    lightgray: 'rgb("#d3d3d3")',
    grey: 'gray',
  }
  if (ALIAS[s] != null) return ALIAS[s]!
  return cssColorToTypst(s)
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
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta',
  'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi',
  'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi',
  'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma',
  'Upsilon', 'Phi', 'Psi', 'Omega',
  // NOTE: the LaTeX var* variants (varepsilon/vartheta/varpi/varrho/varsigma/
  // varphi) are deliberately NOT here — Typst has no `varepsilon` symbol, so
  // they must fall through to LATEX_CMD_TO_TYPST which maps them to `*.alt`.
])

// LaTeX command -> Typst symbol name (only those that differ or need pinning).
const LATEX_CMD_TO_TYPST: Record<string, string> = {
  times: 'times', div: 'div', pm: 'plus.minus', mp: 'minus.plus',
  cdot: 'dot.op', cdots: 'dots.c', ldots: 'dots.h', dots: 'dots.h', vdots: 'dots.v', ddots: 'dots.down',
  leq: 'lt.eq', le: 'lt.eq', geq: 'gt.eq', ge: 'gt.eq', neq: 'eq.not', ne: 'eq.not',
  approx: 'approx', equiv: 'equiv', sim: 'tilde.op', propto: 'prop',
  infty: 'infinity', partial: 'partial', nabla: 'nabla',
  rightarrow: 'arrow.r', to: 'arrow.r', leftarrow: 'arrow.l', Rightarrow: 'arrow.r.double',
  Leftarrow: 'arrow.l.double', leftrightarrow: 'arrow.l.r', mapsto: 'arrow.r.bar',
  forall: 'forall', exists: 'exists', in: 'in', notin: 'in.not', subset: 'subset',
  subseteq: 'subset.eq', supset: 'supset', supseteq: 'supset.eq', cup: 'union', cap: 'inter',
  emptyset: 'nothing', varnothing: 'nothing', setminus: 'without',
  sum: 'sum', prod: 'product', int: 'integral', iint: 'integral.double', iiint: 'integral.triple', oint: 'integral.cont',
  varepsilon: 'epsilon.alt', varphi: 'phi.alt', vartheta: 'theta.alt', varrho: 'rho.alt',
  varsigma: 'sigma.alt', varpi: 'pi.alt',
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
  // Modular arithmetic, extra relations & arrows, misc operators found while
  // broadening the math test corpus.
  bmod: 'mod', mid: 'divides', ll: 'lt.double', gg: 'gt.double',
  hookrightarrow: 'arrow.r.hook', hookleftarrow: 'arrow.l.hook',
  rightleftharpoons: 'harpoons.rtlb', longrightarrow: 'arrow.r.long',
  longleftarrow: 'arrow.l.long', Longrightarrow: 'arrow.r.long.double',
  uparrow: 'arrow.t', downarrow: 'arrow.b', updownarrow: 'arrow.t.b',
  nabla_op: 'nabla', triangleq: 'eq.delta', simeq: 'tilde.eq',
  ncong: 'tilde.equiv.not', nsubseteq: 'subset.eq.not', supseteq_op: 'supset.eq',
  models: 'tack.r', vdash: 'tack.r', dashv: 'tack.l',
  Pr: 'Pr', hom: 'hom', lcm: 'lcm', mod: 'mod',
}

/** Chars special in Typst math that must be escaped to render literally.
 *  Every character emitted into a `$...$` span must pass through here: a raw
 *  `#` switches Typst from math markup into code-expression mode (a breakout),
 *  a raw `$` closes the span, `"` opens a string, and a lone `\` is a line
 *  break / escape introducer. Escaping them keeps authored math literal and
 *  prevents a malformed formula from crashing the whole compile. */
function escMathLiteral(c: string): string {
  if (c === '#' || c === '$' || c === '"') return `\\${c}`
  if (c === '\\') return '\\\\' // literal backslash (a lone \ is a Typst line break)
  if (c === '&') return '' // alignment tab — drop
  return c
}

/**
 * Scan a LaTeX math string and translate `\cmd`, `^`/`_` scripts, `{...}`
 * groups, and multi-arg constructs (frac/sqrt/binom/text) into Typst math.
 * Pure function: creates its own cursor so nested calls don't share state.
 * `depth` bounds nested `{...}` recursion so a deeply-nested formula can't burn
 * unbounded synchronous CPU (or overflow the stack) on the request thread;
 * past the limit the remaining inner text is emitted escaped-verbatim.
 */
const MAX_MATH_NESTING = 32
function latexToTypstMath(latex: string, depth = 0): string {
  let i = 0
  // Defensive: strip ASCII control characters (TAB, form-feed, CR, etc.) from
  // the LaTeX before parsing. They never belong in a formula and only appear
  // when the source was corrupted upstream — e.g. a formula authored in a
  // non-raw JS string where `	o`/`rac` collapsed to a literal TAB (U+0009) /
  // form-feed (U+000C). Left in place they desync the command scanner (`rac`
  // becomes `<FF>rac`, spelled out as `r a c ...`) and can emit stray tokens
  // like `cs` that Typst rejects as an unknown variable, garbling the whole
  // PDF. Dropping them lets the rest of the formula still render.
  const src = latex
    // TAB and CR are legitimate-ish whitespace in hand-written LaTeX; normalize
    // them to a space so a corrupted `	o`→TAB still reads as a token break
    // rather than gluing identifiers together.
    .replace(/[\t\r]/g, ' ')
    // Drop the remaining ASCII control chars (backspace, vertical tab, FORM-FEED
    // from a corrupted `\frac`→U+000C, etc.). Left in place they desync the
    // command scanner and emit stray tokens like `cs` that Typst rejects as an
    // unknown variable, garbling the whole PDF.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
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
    if (depth >= MAX_MATH_NESTING) return inner.replace(/[#$"\\]/g, (ch) => escMathLiteral(ch))
    return latexToTypstMath(inner, depth + 1)
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
    // Escape the bare arg: a raw `#`/`$`/`\` here would break out of the
    // enclosing `$...$` span into Typst code mode and crash the compile.
    return ch ? escMathLiteral(ch) : ''
  }

  /**
   * Read a `{...}` argument VERBATIM (no math conversion), for arguments that
   * are not math — e.g. the colour name in `\color{red}` / `\textcolor{red}`.
   * Returns the raw inner text so `red` stays `red` (not `r e d`).
   */
  function readRawGroupArg(): string {
    while (i < len && /\s/.test(src[i]!)) i++
    if (src[i] !== '{') {
      // Bare single-token colour (rare): read one run of word/#/hex chars.
      let t = ''
      while (i < len && /[a-zA-Z0-9#]/.test(src[i]!)) { t += src[i]; i++ }
      return t
    }
    i++
    let d = 1
    const s2 = i
    while (i < len && d > 0) {
      if (src[i] === '{') d++
      else if (src[i] === '}') { d--; if (d === 0) break }
      i++
    }
    const inner = src.slice(s2, i)
    if (src[i] === '}') i++
    return inner
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
    // Escape the bare script arg: a raw `#`/`$`/`\` here (e.g. `x^#`) would
    // break out of the enclosing `$...$` span and crash the compile.
    return ch ? escMathLiteral(ch) : ''
  }

  /**
   * Emit a single-arg Typst function only when the arg is non-empty. A missing
   * arg (e.g. `\hat` at end of input, or `\bar{}`) would otherwise produce
   * `name()` which Typst rejects with "missing argument: body". Empty => drop.
   */
  function decorate(fn: string, arg: string): string {
    // Leading space so the function name never fuses with a preceding letter
    // into one identifier (e.g. `d` + `\vec{r}` must be `d arrow(r)`, not
    // `darrow(r)` which Typst reads as an unknown variable). Typst math
    // collapses the extra space, so this is visually a no-op.
    return arg.trim().length ? ` ${fn}(${arg})` : ''
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
      case 'color': {
        // `\color{c} ...`: colour subsequent content. Read the colour name RAW
        // (not math-converted — `red` must stay `red`, not become `r e d`).
        // Unknown/unsafe colours are dropped (render uncoloured) rather than
        // injected raw — an unhandled `\color` used to spell out as
        // `"color"r e d…`, emitting stray identifiers like `dx` that Typst rejects
        // as unknown variables and failing the whole PDF.
        //
        // Two forms are common in user input:
        //   \color{red}{x}  — colour just the following group (like \textcolor)
        //   \color{red} x   — switch: colour the rest of the enclosing group
        // Prefer the localised group form when a `{` immediately follows, so we
        // don't accidentally swallow trailing `= c` etc. into the colour.
        const fill = mathColorArgToTypst(readRawGroupArg())
        while (i < len && /\s/.test(src[i]!)) i++
        let inner: string
        if (src[i] === '{') {
          inner = readBraceGroup().trim() || 'zws'
        } else {
          // Rest-of-scope form `\color{red} E = mc^2`: capture the RAW remaining
          // LaTeX up to the enclosing `}` / end, then run it through the full
          // converter so letters get spaced (`mc` -> `m c`) exactly like the
          // top-level path. Accumulating already-converted fragments here used
          // to leave bare runs like `mc` fused, which Typst rejects as an
          // unknown variable and fails the whole PDF compile.
          let raw = ''
          let d = 0
          while (i < len) {
            const ch = src[i]!
            if (ch === '}' && d === 0) break
            if (ch === '\\') { raw += src[i]!; raw += src[i + 1] ?? ''; i += 2; continue }
            if (ch === '{') d++
            else if (ch === '}') d--
            raw += ch
            i++
          }
          inner = latexToTypstMath(raw, depth + 1).trim() || 'zws'
        }
        return fill ? ` #text(fill: ${fill})[$${inner}$]` : ` ${inner}`
      }
      case 'textcolor':
      case 'colorbox': {
        // `\textcolor{c}{content}` / `\colorbox{c}{content}`: colour just the
        // second argument. Same safety policy as `\color`.
        const fill = mathColorArgToTypst(readRawGroupArg())
        const inner = readGroupArg().trim() || 'zws'
        return fill ? ` #text(fill: ${fill})[$${inner}$]` : ` ${inner}`
      }
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac': {
        const a = readGroupArg(); const b = readGroupArg()
        // Empty numerator/denominator would make Typst's frac() error; substitute
        // a zero-width placeholder so the fraction still renders. `\cfrac`
        // (continued fraction) has no dedicated Typst primitive, so it renders
        // as a normal frac() — visually equivalent for our nesting depth.
        return `frac(${a.trim() || "zws"}, ${b.trim() || "zws"})`
      }
      case 'overset':
      case 'stackrel': {
        // \overset{top}{base} / \stackrel{top}{base}. Typst has no `overset`,
        // but `limits(base)^(top)` places the annotation directly above.
        const top = readGroupArg().trim() || 'zws'
        const base = readGroupArg().trim() || 'zws'
        return ` limits(${base})^(${top})`
      }
      case 'underset': {
        // \underset{bottom}{base} -> Typst limits(base)_(bottom)
        const bottom = readGroupArg().trim() || 'zws'
        const base = readGroupArg().trim() || 'zws'
        return ` limits(${base})_(${bottom})`
      }
      case 'pmod': {
        // \pmod{n} -> parenthesised modulus with a leading gap: `quad (mod n)`
        const n = readGroupArg().trim() || 'zws'
        return ` quad (mod ${n})`
      }
      case 'limits':
      case 'nolimits':
      case 'displaystyle':
      case 'textstyle':
      case 'scriptstyle':
        // Layout hints with no Typst equivalent that matters here — drop them so
        // e.g. `\int\limits_0^1` keeps its scripts on the integral.
        return ''
      case 'substack': {
        // \substack{a \\ b} -> stacked scripts. Typst has no direct primitive;
        // render the rows in a tight `vec`-like column via `#stack`-free
        // fallback: join rows with a thin vertical gap using `mat` single column.
        const body = readGroupArg()
        const rows = body.split(/\\\\|\\/).map((r) => r.trim()).filter(Boolean)
        return rows.length ? ` mat(delim: #none, ${rows.join('; ')})` : ''
      }
      case 'xrightarrow':
      case 'xleftarrow': {
        // \xrightarrow{f} -> arrow with the label as a superscript.
        while (i < len && /\s/.test(src[i]!)) i++
        // optional [under] arg (rare) then {over} label
        let over = ''
        if (src[i] === '{') over = readBraceGroup()
        const dir = name === 'xrightarrow' ? 'arrow.r.long' : 'arrow.l.long'
        return over.trim() ? ` ${dir}^(${over.trim()})` : ` ${dir}`
      }
      case 'sqrt': {
        while (i < len && /\s/.test(src[i]!)) i++
        if (src[i] === '[') {
          const s2 = i + 1
          while (i < len && src[i] !== ']') i++
          const idx = latexToTypstMath(src.slice(s2, i), depth + 1)
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
        // Escape the delimiter: a raw `#`/`$`/`\` (e.g. `\left#`) would break
        // out of the `$...$` span into Typst code mode and crash the compile.
        return d ? escMathLiteral(d) : ''
      }
      case 'hat': return decorate('hat', readGroupArg())
      case 'bar':
      case 'overline': return decorate('overline', readGroupArg())
      case 'vec': return decorate('arrow', readGroupArg())
      case 'dot': return decorate('dot', readGroupArg())
      case 'ddot': return decorate('dot.double', readGroupArg())
      case 'tilde': return decorate('tilde', readGroupArg())
      case 'overbrace':
      case 'underbrace': {
        // \overbrace{body}^{sup} / \underbrace{body}_{sub} -> Typst
        // overbrace(body, annotation) / underbrace(body, annotation). The
        // annotation script is optional. A leading space avoids fusing with a
        // preceding identifier char.
        const body = readGroupArg().trim() || 'zws'
        const fn = name === 'overbrace' ? 'overbrace' : 'underbrace'
        const wantScript = name === 'overbrace' ? '^' : '_'
        // Skip whitespace, then consume an optional matching ^{...}/_{...}.
        let j = i
        while (j < len && /\s/.test(src[j]!)) j++
        if (src[j] === wantScript) {
          i = j + 1
          const ann = readArg().trim()
          return ann ? ` ${fn}(${body}, ${ann})` : ` ${fn}(${body})`
        }
        return ` ${fn}(${body})`
      }
      case 'boldsymbol':
      case 'mathbf': return decorate('bold', readGroupArg())
      case 'mathbb': return decorate('bb', readGroupArg())
      case 'mathcal': return decorate('cal', readGroupArg())
      case 'mathfrak': return decorate('frak', readGroupArg())
      case 'begin': {
        // Environment: capture the name, then the raw body up to the matching
        // \end{name}, and convert matrix/cases-like environments to Typst's
        // mat()/cases() so rows & columns actually GROUP (previously begin/end
        // and the & / \\ separators were discarded, mushing every cell into one
        // flat run with no brackets).
        while (i < len && /\s/.test(src[i]!)) i++
        let env = ''
        if (src[i] === '{') { i++; while (i < len && src[i] !== '}') { env += src[i]; i++ } if (src[i] === '}') i++ }
        // Read raw body until the matching \end{env} (track nested begins).
        let bodyStart = i
        let nest = 1
        let bodyEnd = len
        const re = /\\(begin|end)\s*\{[^}]*\}/g
        re.lastIndex = i
        let mm: RegExpExecArray | null
        while ((mm = re.exec(src))) {
          if (mm[1] === 'begin') nest++
          else { nest--; if (nest === 0) { bodyEnd = mm.index; break } }
        }
        const rawBody = src.slice(bodyStart, bodyEnd)
        // Advance the cursor past the matching \end{...}.
        i = bodyEnd
        { const e = /\\end\s*\{[^}]*\}/g; e.lastIndex = i; const em = e.exec(src); if (em && em.index === i) i = e.lastIndex }
        return renderMathEnv(env, rawBody, depth)
      }
      case 'end': {
        // A stray \end (no matching begin in this scope): consume its {name}.
        while (i < len && /\s/.test(src[i]!)) i++
        if (src[i] === '{') { while (i < len && src[i] !== '}') i++; if (src[i] === '}') i++ }
        return ''
      }
      default: {
        // Greek letters and mapped symbols/operators get a LEADING space so they
        // never fuse with a preceding identifier char into one token (e.g.
        // `e^{i` + `\pi}` must be `i pi`, not `ipi`; `\cos` + `\theta` must be
        // `cos theta`, not `costheta`). Both would be unknown Typst variables.
        // Typst math collapses the extra space visually.
        if (GREEK.has(name)) return ` ${name}`
        const mapped = LATEX_CMD_TO_TYPST[name]
        if (mapped) return ` ${mapped}`
        // Unknown command. A bare multi-letter identifier in Typst math is an
        // ERROR (unknown variable), so emit it as an upright text string, which
        // always compiles and preserves the source legibly. Single letters are
        // valid math idents, so pass those through bare.
        if (name.length === 1) return name
        return ` "${esc(name)}"`
      }
    }
  }

  let out = ''
  while (i < len) {
    const ch = src[i]!
    if (ch === '\\') { out += readCommand(); continue }
    if (ch === '{') { out += readBraceGroup(); continue }
    if (ch === '^' || ch === '_') {
      // A script (`^`/`_`) needs a preceding base atom; without one Typst errors
      // (`unexpected hat`). If nothing renderable precedes it, insert a
      // zero-width base so `^2` / `_i` still compile.
      if (!/[^\s]$/.test(out)) out += 'zws'
      out += ch; i++
      const arg = readArg()
      // If a parenthesized group immediately follows the script (e.g.
      // `\log_b(xy)`), Typst would otherwise pull that group INTO the script
      // (rendering `log_(b(xy))`). Force-wrap the script arg in parens so it is
      // bounded and the following `(...)` stays a normal base-line argument.
      let j = i
      while (j < len && /\s/.test(src[j]!)) j++
      const followedByParen = src[j] === '('
      out += followedByParen && !/^\(.*\)$/.test(arg) ? `(${arg})` : arg
      continue
    }
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
    if (ch === '|') {
      // Two ADJACENT bars (`||`) are read by Typst as the norm delimiter `‖`,
      // but in LaTeX `|a||b|` means abs(a)*abs(b) (two separate single bars).
      // Insert a thin space between consecutive bars so they stay two single
      // `|` delimiters instead of merging into a double-bar norm.
      if (out.endsWith('|')) out += 'thin'
      out += '|'; i++; continue
    }
    out += escMathLiteral(ch)
    i++
  }
  // Collapse redundant whitespace introduced by the leading/trailing spaces we
  // add around symbols/decorators to prevent token fusion. Typst math treats
  // any run of spaces as a single gap, so this is visually identical but keeps
  // the emitted source tidy (and stable for tests).
  return out.replace(/ {2,}/g, ' ').replace(/^ | $/g, '')
}

/**
 * Convert a LaTeX math environment body (matrix / cases / aligned / …) to a
 * Typst grouped construct so rows and columns are preserved and delimited.
 *
 * Splits the raw body on `\\` (rows) and `&` (columns), converting each cell
 * with the normal math converter. Without this, `\begin{pmatrix} a & b \\ c & d
 * \end{pmatrix}` collapsed to a flat `a b c d` run with no brackets — the
 * "公式没组合起来" bug.
 */
function renderMathEnv(env: string, rawBody: string, depth: number): string {
  const name = env.replace(/\*$/, '')
  // Split into rows on `\\`, then columns on unescaped `&`.
  const rows = rawBody
    .split(/\\\\/)
    .map((r) => r.trim())
  const grid = rows.map((row) =>
    row.split(/(?<!\\)&/).map((cell) => latexToTypstMath(cell.trim(), depth + 1).trim() || 'zws'),
  )
  // Drop a trailing all-empty row (from a final `\\`).
  while (grid.length > 1 && grid[grid.length - 1]!.every((c) => c === 'zws')) grid.pop()

  const matDelim: Record<string, string> = {
    matrix: '#none',
    pmatrix: '"("',
    bmatrix: '"["',
    Bmatrix: '"{"',
    vmatrix: '"|"',
    Vmatrix: '"||"',
  }
  // Open/close delimiter literals (Typst math markup) for the tight `lr()` form.
  const matFence: Record<string, [string, string]> = {
    pmatrix: ['(', ')'],
    bmatrix: ['[', ']'],
    Bmatrix: ['{', '}'],
    vmatrix: ['|', '|'],
    Vmatrix: ['||', '||'],
  }

  if (name === 'cases') {
    // Typst cases(): one branch per row, comma-separated. Separate the value from
    // its condition with an explicit `quad` gap so there is always clear spacing
    // (a bare `&` only sets an alignment point and can render with almost no gap;
    // the value and condition looked glued together without this).
    const rowsJoined = grid.map((r) => r.join(' quad ')).join(', ')
    return `cases(${rowsJoined})`
  }

  if (name in matDelim) {
    const delim = matDelim[name]!
    if (delim === '#none') {
      // Unfenced matrix: no delimiters to size.
      const body = grid.map((r) => r.join(', ')).join('; ')
      return `mat(delim: #none; ${body})`
    }
    // Fenced matrix (pmatrix/bmatrix/...): Typst's default `mat(delim: ...)`
    // auto-sizes the brackets with generous padding, so a 2-row matrix's
    // delimiters tower ~20-25% above the content. Build the grid WITHOUT a
    // built-in delimiter and wrap it in `lr(size: #88%, ...)` so the brackets
    // hug the two rows tightly instead of leaving big vertical gaps.
    const body = grid.map((r) => r.join(', ')).join('; ')
    const [open, close] = matFence[name]!
    return `lr(size: #88%, ${open} mat(delim: #none, ${body}) ${close})`
  }

  if (name === 'array') {
    const body = grid.map((r) => r.join(', ')).join('; ')
    return `mat(delim: #none; ${body})`
  }

  // aligned / align / gathered / split / equation: stack rows, drop the & align
  // tabs (Typst auto-aligns display math); join rows with line breaks.
  return grid.map((r) => r.join(' ')).join(' \\ ')
}

// ── emoji ───────────────────────────────────────────────────────────────────
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
      // Explicit heavy weight PLUS a hairline stroke to synthesize bold. CJK
      // fonts (PingFang SC / Noto Sans CJK SC) often lack a true Bold cut, so
      // `weight: "bold"` silently falls back to Regular and Chinese looks
      // unchanged (only Latin, which has a Bold face, thickens). A thin stroke
      // in the SAME colour as the glyph fill fattens the strokes for every
      // script, so Chinese bold is visible too. `0.02em` ≈ fake-bold weight
      // without turning glyphs into blobs; stroke paint defaults to the text
      // fill so coloured/bold combinations keep their colour.
      return `#text(weight: "bold", stroke: 0.02em)[${inner}]`
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

/**
 * Reverse escContent(): drop the backslashes it added before Typst markup chars
 * and turn the non-breaking spaces we use for spacing back into plain spaces.
 * Used to recover literal text before putting it inside #raw("...").
 */
function unescapeContent(s: string): string {
  return s.replace(/\\([\\#*_`$[\]@<>~/=+-])/g, '$1').replace(/\u00A0/g, ' ')
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
  /** True while rendering inside a table cell. Cell images are constrained to
   *  the cell width (100%) instead of the page-based cap, because Typst cannot
   *  reliably resolve a `layout()` measurement inside deeply nested `1fr`
   *  columns — so a plain page cap let deep-nested images overflow their cell. */
  inCell?: boolean
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
  // Inside a table cell, constrain to the cell width (100%). Typst resolves
  // `100%` against the actual cell even when it is a deeply nested `1fr`
  // column, whereas the `layout()` cap could not — so this stops nested-cell
  // images from overflowing their cell / overlapping the table borders.
  if (ctx.inCell) {
    return `\n#figure(__capImage("${esc(path)}", w: 100%))\n`
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

/** Per-formula and per-document LaTeX byte caps. `latexToTypstMath` is a
 *  synchronous CPU-bound scan run on the request thread before the typst child
 *  is spawned (so the compile queue/timeout can't protect it). KaTeX formulas
 *  are tiny (a few KB at most), so cap a single formula and the per-document
 *  total to keep one export request from starving the Node event loop. */
const MAX_MATH_LATEX_BYTES = 8 * 1024
const MAX_MATH_LATEX_TOTAL_BYTES = 256 * 1024
let mathLatexBudget = MAX_MATH_LATEX_TOTAL_BYTES
// When true, math nodes emit their raw LaTeX as a quoted string instead of
// converting. Set for the whole-document verbatim retry (see renderTypst).
let forceVerbatimMath = false
// Per-formula verbatim set: when non-null, a formula whose RAW latex is in the
// set renders verbatim while all others convert. Enables per-formula fallback
// (one bad formula degrades to text; the rest stay real math).
let verbatimFormulaSet: Set<string> | null = null

/** Convert LaTeX->Typst math; on any converter throw, fall back to a quoted
 *  verbatim source so the formula is still visible (never crashes the doc).
 *  Oversized formulas (or once the per-doc budget is exhausted) skip conversion
 *  and fall back to verbatim text, so a huge `latex` attr can't hang the loop. */
function safeMath(latex: string): string {
  // Per-formula fallback: this exact formula was probed as compile-breaking, so
  // emit it verbatim while the rest of the document still converts to real math.
  if (verbatimFormulaSet && verbatimFormulaSet.has(latex)) {
    return `"${esc(latex)}"`
  }
  // Defensive: strip C0 control characters (except none are legal in KaTeX
  // source). Corrupt data — e.g. a seed that stored `\to`/`\frac` as a non-raw
  // JS string so `\t`→TAB(U+0009), `\f`→FF(U+000C) — leaves raw control bytes
  // in the `latex` attr. Those bytes make the converter emit Typst-invalid
  // tokens (`rac`, fused identifiers) that fail the WHOLE compile and drag the
  // entire document into the verbatim fallback. Removing them here contains the
  // damage to the one bad formula (it degrades to text) instead of garbling the
  // whole export. It cannot rebuild `\frac` from `rac` — corrupt data must be
  // fixed at the source — but it stops one bad formula from crashing the rest.
  const sanitized = latex.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[\t\r]/g, ' ')
  latex = sanitized
  // Verbatim retry mode, or oversized/over-budget: skip conversion entirely and
  // emit the raw source as a quoted string (always compile-safe).
  if (forceVerbatimMath || latex.length > MAX_MATH_LATEX_BYTES || mathLatexBudget <= 0) {
    return `"${esc(latex)}"`
  }
  mathLatexBudget -= latex.length
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
  //
  // For a NESTED table (rendered inside a cell) we must NOT use the editor's
  // absolute px widths: those are page-scale and easily exceed the narrow
  // containing cell, so the nested table (and its images) overflow the cell.
  // Instead convert every column to a proportional `fr` unit derived from the
  // px ratios, so the nested table always fits its container while keeping the
  // relative column proportions. Columns with no width fall back to 1fr.
  let columnsArg: string
  if (ctx.inCell && hasWidths) {
    // Nested table: convert px widths to proportional `fr` so the table fits its
    // container. But the editor's stored px widths are page-scale and often
    // lopsided (e.g. a column holding an image is 600px while siblings are ~90px
    // -> 75/13/12), which crushes the narrow columns to unreadable slivers in the
    // fixed container. The web view never shows this because CSS min-content puts
    // a floor under each column. Mirror that: clamp every column's share to at
    // least `MIN_SHARE` of an equal split so no column collapses, then keep the
    // remaining proportions among the columns that have room to grow.
    const n = widths.length
    const MIN_SHARE = 0.6 // each column gets >= 60% of an equal (1/n) share
    const MAX_SHARE = 1.6 // and <= 1.6x an equal share, so no column dominates
    // Raw proportional weights (unset columns treated as the average weight so
    // they participate like a normal 1fr column).
    const known = widths.filter((w): w is number => w != null)
    const avg = known.length ? known.reduce((s, w) => s + w, 0) / known.length : 1
    const raw = widths.map((w) => (w != null ? w : avg))
    const rawSum = raw.reduce((s, w) => s + w, 0) || 1
    // Normalize to fr-vs-equal (share * n), then clamp each to [MIN_SHARE,
    // MAX_SHARE]. Clamping is the final step so the ceiling actually holds (a
    // renormalize-after-clamp would push the widest column back over the cap).
    // Typst tolerates fr tracks that don't sum to exactly n; they still split the
    // row proportionally, so the guaranteed [floor, ceil] bound is what matters.
    const frs = raw.map((w) => {
      const share = (w / rawSum) * n
      return Math.min(MAX_SHARE, Math.max(MIN_SHARE, share))
    })
    columnsArg = `(${frs.map((f) => `${f.toFixed(2)}fr`).join(', ')})`
  } else {
    columnsArg = hasWidths
      ? `(${widths.map((w) => (w != null ? `${(w * 0.75).toFixed(1)}pt` : '1fr')).join(', ')})`
      : `(${Array.from({ length: cols }, () => '1fr').join(', ')})`
  }

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
    const body = renderChildren(cell, { ...ctx, inCell: true }).trim() || ' '
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
    ? `\n  fill: (_, row) => if row == 0 { rgb("#f2f3f5") },`
    : ''
  return `\n#table(\n  columns: ${columnsArg},\n  stroke: 0.5pt + rgb("#e5e6eb"),\n  inset: 7pt,${fillArg}\n  ${parts.join(',\n  ')}\n)\n`
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
    // Explicit per-level heading sizes. Typst's default heading scaling is subtle
    // for a CJK-first body font (the levels look nearly identical), so pin each
    // level to a distinct size matching the editor's H1..H6 scale.
    '#show heading.where(level: 1): set text(size: 22pt)',
    '#show heading.where(level: 2): set text(size: 18pt)',
    '#show heading.where(level: 3): set text(size: 15pt)',
    '#show heading.where(level: 4): set text(size: 13pt)',
    '#show heading.where(level: 5): set text(size: 12pt)',
    '#show heading.where(level: 6): set text(size: 11pt)',
    '#show link: set text(fill: rgb("#0969da"))',
    '#set table(align: left + horizon)',
    // Compact matrix/cases spacing so auto-sized delimiters hug the entries and
    // piecewise branches keep a clear gap between value and condition.
    '#set math.mat(row-gap: 0em, column-gap: 0.55em)',
    '#set math.cases(gap: 0.5em)',
    // Image max-width helper: cap to the page CONTENT width so large images
    // never overflow, but keep small images at natural size (no upscaling),
    // matching the editor/HTML `max-width: 100%; height: auto`. An optional
    // explicit width is applied but still bounded by the content width.
    '#let __capImage(path, w: none) = layout(size => {',
    '  // `size.width` is the width of the CONTAINING block (page body at top',
    '  // level, or the enclosing cell when nested). Cap the image to it so it',
    '  // never overflows a narrow (possibly deeply nested) table cell, but never',
    '  // upscale a naturally smaller image.',
    '  let avail = size.width',
    '  let nat = measure(image(path))',
    '  let target = if w != none {',
    '    if type(w) == length and w > avail { avail } else { w }',
    '  } else if nat.width > avail { avail } else { nat.width }',
    '  image(path, width: target)',
    '})',
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
  mathLatexBudget = MAX_MATH_LATEX_TOTAL_BYTES // reset per-document math budget
  forceVerbatimMath = opts.mathMode === 'verbatim'
  verbatimFormulaSet = opts.verbatimFormulas ?? null
  const ctx: RenderCtx = {
    attachments: opts.attachments,
    imagePaths: opts.imagePaths ?? new Map(),
    depth: 0,
  }
  const body = (doc?.content ?? []).map((n) => renderNode(n, ctx)).join('')
  return `${preamble(opts.title)}\n${body}\n`
}

// Exposed for unit tests only.
export const __test = { latexToTypstMath, wrapMark, cssColorToTypst, cssFontSizeToTypst, isSafeHref, renderTypstNode: renderNode, renderTextNode, escMathLiteral }
