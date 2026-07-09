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
    return trimmed.length ? trimmed : null
  } catch {
    return null
  }
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
