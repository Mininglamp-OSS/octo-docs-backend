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

// OOXML list levels are 0..8. Bound the fallback loop start so a hostile
// w:ilvl (Infinity or a huge finite value) can never spin past the real range.
const MAX_LIST_LEVEL = 8

export interface Numbering {
  /** (numId → ilvl → kind). Missing entries default to 'bullet'. */
  kindOf(numId: string, ilvl: number): ListKind
  /**
   * (numId → ilvl → first number). The list's starting value, read from the
   * level's `w:start` (or a `w:num`-level `w:startOverride`). Missing entries
   * return 1. Lets an ordered list that begins at e.g. 20/41 keep its numbering
   * instead of silently restarting at 1 on import.
   */
  startOf(numId: string, ilvl: number): number
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
  // abstractNumId → (ilvl → start value from the level's w:start)
  const abstractStart = new Map<string, Map<number, number>>()
  // numId → abstractNumId
  const numToAbstract = new Map<string, string>()
  // numId → (ilvl → startOverride) from <w:num>/<w:lvlOverride>/<w:startOverride>
  const startOverride = new Map<string, Map<number, number>>()

  if (numberingXml) {
    const root = parseXml(numberingXml)
    const numbering = asArray<XmlNode>(root['w:numbering'])[0]
    if (numbering) {
      for (const an of asArray<XmlNode>(numbering['w:abstractNum'])) {
        const abstractId = attr(an, 'w:abstractNumId')
        if (!abstractId) continue
        const levels = new Map<number, ListKind>()
        const starts = new Map<number, number>()
        for (const lvl of asArray<XmlNode>(an['w:lvl'])) {
          const ilvl = Number(attr(lvl, 'w:ilvl') ?? '0')
          const fmt = (attr(asArray<XmlNode>(lvl['w:numFmt'])[0], 'w:val') ?? '').toLowerCase()
          // 'none' formats render no marker but are still list levels; treat as bullet.
          levels.set(ilvl, ORDERED_FORMATS.has(fmt) ? 'ordered' : 'bullet')
          const start = Number(attr(asArray<XmlNode>(lvl['w:start'])[0], 'w:val') ?? '')
          if (Number.isFinite(start)) starts.set(ilvl, start)
        }
        abstract.set(abstractId, levels)
        abstractStart.set(abstractId, starts)
      }
      for (const num of asArray<XmlNode>(numbering['w:num'])) {
        const numId = attr(num, 'w:numId')
        const abstractId = attr(asArray<XmlNode>(num['w:abstractNumId'])[0], 'w:val')
        if (numId && abstractId) numToAbstract.set(numId, abstractId)
        // A <w:lvlOverride>/<w:startOverride> on the instance wins over the
        // abstract level's own w:start (Word uses this to restart/continue).
        if (numId) {
          const ov = new Map<number, number>()
          for (const lo of asArray<XmlNode>(num['w:lvlOverride'])) {
            const ilvl = Number(attr(lo, 'w:ilvl') ?? '0')
            const so = Number(attr(asArray<XmlNode>(lo['w:startOverride'])[0], 'w:val') ?? '')
            if (Number.isFinite(so)) ov.set(ilvl, so)
          }
          if (ov.size) startOverride.set(numId, ov)
        }
      }
    }
  }

  return {
    kindOf(numId: string, ilvl: number): ListKind {
      const abstractId = numToAbstract.get(numId)
      if (abstractId == null) return 'bullet'
      const levels = abstract.get(abstractId)
      if (!levels) return 'bullet'
      // Defence-in-depth: callers clamp w:ilvl to 0..MAX_LIST_LEVEL, but guard
      // here too so a hostile level can never drive the descending fallback
      // loop past the real level range — a non-finite value (Infinity - 1 ===
      // Infinity) would never exit, and a huge finite value would burn CPU.
      // OOXML levels are 0..8; nothing above MAX_LIST_LEVEL can ever match.
      const raw = Number.isFinite(ilvl) ? Math.max(0, Math.floor(ilvl)) : 0
      const from = Math.min(raw, MAX_LIST_LEVEL)
      // Fall back to the nearest lower defined level, then to bullet.
      for (let l = from; l >= 0; l--) {
        const k = levels.get(l)
        if (k) return k
      }
      return 'bullet'
    },
    startOf(numId: string, ilvl: number): number {
      // Instance-level startOverride wins, then the abstract level's w:start.
      const ov = startOverride.get(numId)?.get(ilvl)
      if (ov != null && Number.isFinite(ov)) return ov
      const abstractId = numToAbstract.get(numId)
      if (abstractId == null) return 1
      const start = abstractStart.get(abstractId)?.get(ilvl)
      return start != null && Number.isFinite(start) ? start : 1
    },
  }
}
