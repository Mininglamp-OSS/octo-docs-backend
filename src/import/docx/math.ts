/**
 * Math reconstruction (commit ⑤): OOXML OMML (m:oMath) → LaTeX.
 *
 * This is the exact reverse of the docx EXPORT math pipeline, which is:
 *
 *   LaTeX ──(MathJax TeX input)──▶ MathML ──(custom mathmlToOmml)──▶ OMML
 *
 * so the import pipeline is:
 *
 *   OMML ──(omml2mathml)──▶ MathML ──(mathml-to-latex)──▶ LaTeX
 *
 * The recovered LaTeX is stored on the editor's blockMath / inlineMath node
 * (`attrs.latex`) — the same shape the editor and the exporter use, so an
 * export→import round-trip reconstructs the formula. The symmetry is the whole
 * validation win red猫 called out: our own exported docx must round-trip its
 * formulas back to (semantically) the same LaTeX.
 *
 * Both converter libs are lightweight (no XSLT processor / headless browser).
 * omml2mathml uses the classic `xmldom` DOM (it reads `.outerHTML`), so we parse
 * with the matching DOMParser. Any failure degrades to null and the caller keeps
 * the raw text / drops the node rather than failing the import.
 */
import omml2mathml from 'omml2mathml'
import { MathMLToLaTeX } from 'mathml-to-latex'
import { DOMParser, XMLSerializer } from 'xmldom'
import type { PmNode } from './types.js'

const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

/**
 * Convert an OMML `<m:oMath>` XML string to LaTeX. Returns null on any failure
 * (unparseable, unsupported constructs) so the caller can degrade gracefully.
 */
export function ommlToLatex(ommlXml: string): string | null {
  const xml = ensureMathNs(ommlXml)
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const mml = omml2mathml(doc as unknown)
    if (!mml) return null
    const mmlStr =
      (mml as { outerHTML?: string }).outerHTML ??
      new XMLSerializer().serializeToString(mml as unknown)
    const latex = MathMLToLaTeX.convert(mmlStr)
    const trimmed = typeof latex === 'string' ? latex.trim() : ''
    if (!trimmed.length) return null
    const normalized = normalizeRecoveredLatex(trimmed)
    // The conversion libs drop OMML run color; recover a single uniform color
    // (as written by `\color`/`\textcolor` on export) by scanning the raw OMML.
    const color = uniformRunColor(xml)
    return color ? `\\textcolor{#${color}}{${normalized}}` : normalized
  } catch {
    return null
  }
}

/**
 * Return the single uniform run color (6-hex, no `#`) shared by EVERY colored
 * run in the OMML, or null when there is no color or the coloring is mixed.
 * Every `<m:r>` that carries text must share the same `<w:color w:val>` for us
 * to safely wrap the whole formula in one `\textcolor`; mixed/partial coloring
 * is left uncolored rather than risk corrupting the structure.
 */
function uniformRunColor(ommlXml: string): string | null {
  const runs = ommlXml.match(/<m:r\b[\s\S]*?<\/m:r>/g)
  if (!runs || runs.length === 0) return null
  let color: string | null = null
  let sawTextRun = false
  for (const r of runs) {
    // Only consider runs that actually carry visible text.
    const t = r.match(/<m:t[^>]*>([\s\S]*?)<\/m:t>/)
    if (!t || t[1]!.length === 0) continue
    sawTextRun = true
    const m = r.match(/<w:color\b[^>]*\bw:val="([0-9a-fA-F]{6})"/)
    const c = m ? m[1]!.toUpperCase() : null
    if (c === null) return null // an uncolored text run → not uniform
    if (color === null) color = c
    else if (color !== c) return null // mixed colors → bail
  }
  return sawTextRun ? color : null
}

/**
 * Clean up LaTeX recovered by `mathml-to-latex` so the editor's math renderer
 * (KaTeX) accepts it and it matches the original source more closely.
 *
 * Two classes of fix, both conservative (exact patterns only):
 *  1. `mathml-to-latex` renders standard accent operators (`<m:acc>` → MathML
 *     `<mover>`) as generic `\overset{…}{…}`. Map the well-known ones back to
 *     their dedicated commands (`\dot`, `\ddot`, `\vec`, `\tilde`) so they render
 *     as true accents rather than a raised symbol. (`\hat` already round-trips.)
 *  2. It wraps a multi-letter function identifier under a script in
 *     `\left(…\right)` and space-separates the letters, e.g. `\sin^2\theta`
 *     becomes `\left(s i n\right)^{2}\theta`. Collapse a parenthesised run of
 *     spaced letters that forms a known function name back to `\name`.
 */
export function normalizeRecoveredLatex(latex: string): string {
  let out = latex

  // 0. `\hdots` is not a KaTeX/LaTeX command; map it to `\dots`. (Also handled on
  //    export, but repair it here too for docx produced elsewhere.)
  out = out.replace(/\\hdots(?![a-zA-Z])/g, '\\dots')

  // 1. Accent operators emitted as \overset{diacritic}{base} → dedicated command.
  const ACCENTS: Array<[RegExp, string]> = [
    [/\\overset\{\\cdot\\cdot\}/g, '\\ddot'],
    [/\\overset\{\\cdot\}/g, '\\dot'],
    [/\\overset\{\\rightarrow\}/g, '\\vec'],
    [/\\overset\{\\to\}/g, '\\vec'],
    [/\\overset\{\\sim\}/g, '\\tilde'],
    [/\\overset\{\^\}/g, '\\hat'],
  ]
  for (const [re, cmd] of ACCENTS) out = out.replace(re, cmd)

  // 2. Multi-letter operator/function names that the library space-separates
  //    (`l i m`, `s i n`, `m o d`) → the dedicated command. This covers both a
  //    bare occurrence and one wrapped by the library in `\left(…\right)`
  //    (e.g. the operand of `\pmod`). Longest names first so `\arcsin` wins over
  //    `\sin`. `mod` maps to `\bmod`.
  const FUNC_NAMES = [
    'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'coth',
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'log', 'ln', 'lg', 'exp', 'lim', 'det', 'gcd', 'max', 'min', 'mod',
  ]
  for (const name of FUNC_NAMES) {
    const spaced = name.split('').join(' ') // e.g. 's i n'
    const cmd = name === 'mod' ? '\\bmod' : `\\${name}`
    // (a) inside \left(…\right): collapse the spaced name but keep the parens,
    //     e.g. `\left(m o d n\right)` → `\left(\bmod n\right)` (balanced).
    out = out.replace(
      new RegExp(`(\\\\left\\()${escapeRe(spaced)}(?![a-zA-Z])`, 'g'),
      `$1${cmd}`,
    )
    // (b) bare, delimited by non-letters (or string ends)
    out = out.replace(
      new RegExp(`(^|[^a-zA-Z])${escapeRe(spaced)}(?![a-zA-Z])`, 'g'),
      (_m, pre: string) => `${pre}${cmd}`,
    )
  }

  // 2b. Unwrap `\left(\fn\right)^{…}` / `_{…}` → `\fn^{…}`: the library parenthesises
  //     a scripted function name, but `\sin^2` needs no parens. Only when the
  //     content is exactly one function command and a script immediately follows.
  out = out.replace(
    /\\left\((\\[a-z]+)\\right\)(?=[\^_])/g,
    (m, cmd: string) => (FUNC_NAMES.includes(cmd.slice(1)) ? cmd : m),
  )

  // 3. Repair a dangling `\right` that has no delimiter argument (the converter
  //    can drop the `.` from `\right.`), which is a hard KaTeX parse error and
  //    renders the whole formula as red raw text. A valid `\right` is followed
  //    by a delimiter: a closer `) ] }`, a bar `|`, an explicit `.`, or a
  //    command like `\rangle`. Only inject `.` when it is followed by none of
  //    those (end of string, or an ordinary token such as `=`, `+`, a letter).
  out = out.replace(/\\right(?![a-zA-Z])(?=\s*$)/g, '\\right.')
  out = out.replace(/\\right(?![a-zA-Z])(\s*)(?![)\]}|.\\])/g, '\\right.$1')

  return out.trim()
}

/** Escape a string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Ensure the m: prefix is bound; wrap/inject the namespace when missing. */
function ensureMathNs(ommlXml: string): string {
  if (ommlXml.includes('xmlns:m=')) return ommlXml
  // Inject the namespace on the first m:-prefixed element.
  return ommlXml.replace(/<m:([a-zA-Z]+)/, `<m:$1 xmlns:m="${OMML_NS}"`)
}

/**
 * Build a math PM node from recovered LaTeX. `display` selects block vs inline
 * (matches the editor's blockMath / inlineMath nodes, attr `latex`).
 */
export function mathNode(latex: string, display: boolean): PmNode {
  return display
    ? { type: 'blockMath', attrs: { latex } }
    : { type: 'inlineMath', attrs: { latex } }
}
