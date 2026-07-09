/**
 * word/numbering.xml parser (commit ③ support).
 *
 * A numbered/bulleted paragraph carries only a `w:numPr` { numId, ilvl }. The
 * actual list FORMAT (bullet vs decimal vs …) lives in numbering.xml through two
 * levels of indirection:
 *
 *   w:num[numId]  ->  w:abstractNumId  ->  w:abstractNum[id]  ->  w:lvl[ilvl]/w:numFmt
 *
 * We resolve that chain once into a flat lookup: (numId, ilvl) -> 'ordered' |
 * 'bullet'. Anything we can't resolve defaults to 'bullet' (the safe, common
 * case) so an unknown numbering never breaks the import.
 */
import { parseXml, asArray, attr, type XmlNode } from './xml.js'

export type ListKind = 'ordered' | 'bullet'

export interface Numbering {
  /** (numId → ilvl → kind). Missing entries default to 'bullet'. */
  kindOf(numId: string, ilvl: number): ListKind
}

/** OOXML w:numFmt/@w:val values that mean "ordered" (everything else = bullet). */
const ORDERED_FORMATS = new Set([
  'decimal',
  'decimalzero',
  'lowerroman',
  'upperroman',
  'lowerletter',
  'upperletter',
  'ordinal',
  'cardinaltext',
  'ordinaltext',
  'decimalenclosedcircle',
  'decimalenclosedfullstop',
  'decimalenclosedparen',
  'chinesecounting',
  'chinesecountingthousand',
  'ideographdigital',
])

export function parseNumbering(numberingXml: Buffer | undefined): Numbering {
  // abstractNumId → (ilvl → kind)
  const abstract = new Map<string, Map<number, ListKind>>()
  // numId → abstractNumId
  const numToAbstract = new Map<string, string>()

  if (numberingXml) {
    const root = parseXml(numberingXml)
    const numbering = asArray<XmlNode>(root['w:numbering'])[0]
    if (numbering) {
      for (const an of asArray<XmlNode>(numbering['w:abstractNum'])) {
        const abstractId = attr(an, 'w:abstractNumId')
        if (!abstractId) continue
        const levels = new Map<number, ListKind>()
        for (const lvl of asArray<XmlNode>(an['w:lvl'])) {
          const ilvl = Number(attr(lvl, 'w:ilvl') ?? '0')
          const fmt = (attr(asArray<XmlNode>(lvl['w:numFmt'])[0], 'w:val') ?? '').toLowerCase()
          // 'none' formats render no marker but are still list levels; treat as bullet.
          levels.set(ilvl, ORDERED_FORMATS.has(fmt) ? 'ordered' : 'bullet')
        }
        abstract.set(abstractId, levels)
      }
      for (const num of asArray<XmlNode>(numbering['w:num'])) {
        const numId = attr(num, 'w:numId')
        const abstractId = attr(asArray<XmlNode>(num['w:abstractNumId'])[0], 'w:val')
        if (numId && abstractId) numToAbstract.set(numId, abstractId)
      }
    }
  }

  return {
    kindOf(numId: string, ilvl: number): ListKind {
      const abstractId = numToAbstract.get(numId)
      if (abstractId == null) return 'bullet'
      const levels = abstract.get(abstractId)
      if (!levels) return 'bullet'
      // Fall back to the nearest lower defined level, then to bullet.
      for (let l = ilvl; l >= 0; l--) {
        const k = levels.get(l)
        if (k) return k
      }
      return 'bullet'
    },
  }
}
