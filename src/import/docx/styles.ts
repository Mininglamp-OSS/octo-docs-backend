/**
 * word/styles.xml parser — styleId → style name resolution.
 *
 * A paragraph's `w:pStyle w:val` carries a *styleId*, which OOXML permits to be
 * either a human-readable token (e.g. `CodeBlock`, `BlockQuote`) OR an opaque
 * numeric id (e.g. `19`, `20`). Word — and the round-trip a document takes when
 * it is copied / re-saved several times — frequently renumbers named styleIds
 * into bare integers while keeping the real name in the style's `<w:name>`.
 *
 * The paragraph classifiers (styledKindOf / blockquoteMarkerOf /
 * codeBlockEndMarker / detailsMarkerOf) match on the NAME (normalised to
 * lower-case, spaces stripped: `Code Block` → `codeblock`). When the pStyle val
 * is a numeric id, matching the id directly fails and every Code Block / Block
 * Quote / Callout / Details paragraph silently degrades to a plain paragraph.
 *
 * This module resolves `styleId → normalised style name` from styles.xml so the
 * classifiers can look through the numeric indirection. When styles.xml is
 * absent or a styleId is not found, callers fall back to normalising the raw
 * styleId itself — so a document that already uses named styleIds keeps working
 * unchanged.
 */
import { parseXmlOrdered, orderedTag, orderedAttr, type OrderedNode } from './xml.js'

export interface StyleMap {
  /**
   * Resolve a pStyle `w:val` (styleId) to its normalised style key: the
   * `<w:name w:val>` lower-cased with whitespace removed. Falls back to the
   * normalised styleId itself when the id has no entry (so named styleIds and
   * unknown ids still classify by their own token).
   */
  keyOf(styleId: string): string
  /**
   * True when `token` matches EITHER the resolved `<w:name>` key OR the raw
   * normalised styleId. Matching is additive on purpose: resolving a numeric
   * styleId to its name must not stop a recognised styleId *token* (e.g.
   * `CodeBlock`) from classifying just because its `<w:name>` is localized or
   * third-party (e.g. `标题 1` / `Source Code`). So a document keeps working
   * whether it carries the token, the numeric id, or both.
   */
  matches(styleId: string, token: string): boolean
}

/** Normalise a style token for classifier comparison: lower-case, no spaces. */
export function normaliseStyleKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

/** Ordered-mode children under a tag name (mirrors document.ts `kids`). */
function orderedKids(node: OrderedNode, tag: string): OrderedNode[] {
  const v = node[tag]
  return Array.isArray(v) ? (v as OrderedNode[]) : []
}

/**
 * Parse styles.xml into a styleId → normalised-name map. Tolerant of a missing
 * or malformed part: returns a StyleMap whose keyOf() just normalises the raw
 * styleId, preserving the pre-styles-map behaviour.
 *
 * styles.xml is parsed in ORDER-PRESERVING mode (parseXmlOrdered) because the
 * object-mode parser mangles this part on real documents (a large styles.xml
 * collapses `w:styles` to a single opaque child), whereas the ordered walker
 * reliably exposes every `w:style` with its `:@` attrs and `w:name` child —
 * the same mode document.ts already uses for the body.
 */
export function parseStyles(buf?: Buffer): StyleMap {
  const idToName = new Map<string, string>()
  if (buf && buf.length > 0) {
    try {
      const top = parseXmlOrdered(buf)
      const stylesNode = top.find((n) => orderedTag(n) === 'w:styles')
      const children = stylesNode ? orderedKids(stylesNode, 'w:styles') : []
      for (const st of children) {
        if (orderedTag(st) !== 'w:style') continue
        const styleId = orderedAttr(st, 'w:styleId')
        if (!styleId) continue
        const nameNode = orderedKids(st, 'w:style').find((c) => orderedTag(c) === 'w:name')
        const name = nameNode ? orderedAttr(nameNode, 'w:val') : null
        if (name) idToName.set(styleId, normaliseStyleKey(name))
      }
    } catch {
      // Malformed styles.xml: fall through to id-normalising keyOf.
    }
  }
  return {
    keyOf(styleId: string): string {
      return idToName.get(styleId) ?? normaliseStyleKey(styleId)
    },
    matches(styleId: string, token: string): boolean {
      const raw = normaliseStyleKey(styleId)
      const named = idToName.get(styleId)
      // Additive: classify when EITHER the resolved <w:name> OR the raw styleId
      // token matches, so resolving a numeric id never regresses a document that
      // relies on the styleId token (localized/third-party <w:name>).
      return raw === token || named === token
    },
  }
}
