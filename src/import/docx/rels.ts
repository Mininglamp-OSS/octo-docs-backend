/**
 * word/_rels/document.xml.rels parser: relationship id → target.
 *
 * Hyperlinks and images reference targets indirectly by r:id; the actual URL /
 * media path lives in the rels part. We keep only the target string and let the
 * consumers decide safety (hyperlinks pass safeHref; images resolve to media
 * entries in the image commit).
 */
import { parseXml, asArray, attr, type XmlNode } from './xml.js'
import type { RelMap } from './document.js'

export interface ParsedRels {
  /** r:id → Target (raw string; consumer sanitises). */
  targets: RelMap
  /** r:id → true when the relationship is TargetMode="External". */
  external: Set<string>
}

export function parseRels(relsXml: Buffer | undefined): ParsedRels {
  const targets: RelMap = new Map()
  const external = new Set<string>()
  if (!relsXml) return { targets, external }

  const root = parseXml(relsXml)
  const relationships = asArray<XmlNode>(root['Relationships'])[0]
  if (!relationships) return { targets, external }

  for (const rel of asArray<XmlNode>(relationships['Relationship'])) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (!id || !target) continue
    targets.set(id, target)
    if ((attr(rel, 'TargetMode') ?? '').toLowerCase() === 'external') external.add(id)
  }

  return { targets, external }
}
