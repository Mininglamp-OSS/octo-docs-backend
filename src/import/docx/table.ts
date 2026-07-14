/**
 * Table reconstruction (commit ④): OOXML w:tbl → ProseMirror table nodes,
 * including merged cells. The reverse of the docx export table serialiser.
 *
 * ProseMirror model: table > tableRow > (tableCell | tableHeader), each cell
 *   attrs { colspan, rowspan, colwidth?: number[] }, content = block+.
 *
 * The two merge mechanisms need opposite handling:
 *
 *   - HORIZONTAL (w:gridSpan)  a single w:tc spans N grid columns. Direct:
 *     colspan = gridSpan. One PM cell.
 *
 *   - VERTICAL (w:vMerge)      the merge is spread across rows. The TOP cell has
 *     w:vMerge w:val="restart" (or the val defaults to restart when the element
 *     is present with no val on the first row); each CONTINUATION row has an
 *     (often empty) w:tc with w:vMerge w:val="continue". ProseMirror has no
 *     continuation cell — it carries rowspan on the top cell only. So we DROP
 *     continuation cells and bump the originating cell's rowspan, tracking the
 *     open vertical merges per grid column.
 *
 * Header rows: a row whose cells sit in w:tblHeader (tblPr/w:tblHeader) or whose
 * first row uses header formatting maps to tableHeader cells. We treat the first
 * row as headers when the table declares tblHeader, matching the export side
 * (rowIdx 0 + tableHeader). Simpler + robust: mark the first row's cells as
 * tableHeader when the table has a header declaration; else all tableCell.
 */
import type { PmNode } from './types.js'
import { orderedTag, orderedAttr, type OrderedNode } from './xml.js'

/** Children array of an ordered-mode node under a given tag. */
function kids(node: OrderedNode, tag: string): OrderedNode[] {
  const v = node[tag]
  return Array.isArray(v) ? (v as OrderedNode[]) : []
}
function firstChild(children: OrderedNode[], tag: string): OrderedNode | undefined {
  return children.find((c) => orderedTag(c) === tag)
}

/** Twips → CSS px (96dpi): 1 px = 15 twips. */
function twipsToPx(twips: number): number {
  return Math.round(twips / 15)
}

// The editor renders documents in an 820px column with 32px side padding, so a
// full-width table fills ~756px of usable content. The exporter writes
// full-width tables as `w:tblW type="pct" w:w="100%"` and sizes the grid to the
// A4 page content (~9026 twips ≈ 602px). Importing those grid twips verbatim
// makes the table render ~150px too narrow. For a percentage-width table we
// therefore either drop the widths (uniform columns → let the table fill 100%
// like a natively inserted one) or rescale them to the editor width (non-uniform
// columns → keep the author's ratios while still filling the page).
const EDITOR_CONTENT_WIDTH_PX = 756

/** An open vertical merge: the originating cell + its current rowspan. */
interface OpenVMerge {
  cell: PmNode
}

/**
 * Convert a w:tbl ordered node (its child array) into a PM table node.
 * `mapCellBlocks` maps a cell's block content (paragraphs/nested lists) — passed
 * in to avoid a circular import with the body walker.
 */
export function mapTable(
  tblChildren: OrderedNode[],
  mapCellBlocks: (tcChildren: OrderedNode[], fillsWidth?: boolean) => PmNode[],
  parentFillsWidth?: boolean,
): PmNode {
  const rows = tblChildren.filter((c) => orderedTag(c) === 'w:tr')

  // Grid-column widths from w:tblGrid/w:gridCol (twips → px), best-effort.
  let colWidths = readGridWidths(tblChildren)

  // Header declaration: tblPr/w:tblHeader OR the first row's trPr/w:tblHeader.
  const tblPr = firstChild(tblChildren, 'w:tblPr')
  const tableDeclaresHeader = tblPr
    ? !!firstChild(kids(tblPr, 'w:tblPr'), 'w:tblHeader')
    : false

  // Column-width normalization so imported tables match how the editor lays out
  // natively created ones (CSS `table-layout:fixed; width:100%`). Only tables the
  // exporter marked full-width (`w:tblW type="pct"`) OR nested tables inside such
  // a table (`parentFillsWidth`) are normalized — a genuine fixed-width Word
  // table is left untouched.
  //   - UNIFORM columns (even distribution, no author ratios) → drop colwidth so
  //     the table fills its container (page for top-level, cell for nested).
  //   - NON-UNIFORM columns (author resized) → keep ratios; a top-level pct table
  //     is scaled to the editor content width.
  const fillsWidth = isPercentWidthTable(tblPr) || parentFillsWidth === true
  if (fillsWidth && colWidths.length > 0) {
    colWidths = columnsAreUniform(colWidths) ? [] : scaleWidthsToEditor(colWidths)
  }

  // Track open vertical merges keyed by the grid column they occupy.
  const openVMerges = new Map<number, OpenVMerge>()

  const rowNodes: PmNode[] = []

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!
    const rowChildren = kids(row, 'w:tr')
    const trPr = firstChild(rowChildren, 'w:trPr')
    const rowIsHeader =
      (trPr ? !!firstChild(kids(trPr, 'w:trPr'), 'w:tblHeader') : false) ||
      (tableDeclaresHeader && rowIdx === 0)

    const cells: PmNode[] = []
    let gridCol = 0

    for (const tc of rowChildren) {
      if (orderedTag(tc) !== 'w:tc') continue
      const tcChildren = kids(tc, 'w:tc')
      const tcPr = firstChild(tcChildren, 'w:tcPr')
      const tcPrChildren = tcPr ? kids(tcPr, 'w:tcPr') : []

      const colspan = readGridSpan(tcPrChildren)
      const vMerge = readVMerge(tcPrChildren)

      if (vMerge === 'continue') {
        // Continuation cell: bump the originating cell's rowspan and DROP this
        // cell. It occupies `colspan` grid columns.
        const open = openVMerges.get(gridCol)
        if (open) {
          const attrs = open.cell.attrs as Record<string, unknown>
          attrs.rowspan = (Number(attrs.rowspan) || 1) + 1
        }
        // Even if we somehow lost the origin, skip emitting a cell.
        gridCol += colspan
        continue
      }

      // A real (restart or plain) cell.
      const width = sumColWidths(colWidths, gridCol, colspan)
      const attrs: Record<string, unknown> = {}
      if (colspan > 1) attrs.colspan = colspan
      if (width.length) attrs.colwidth = width

      const cell: PmNode = {
        type: rowIsHeader ? 'tableHeader' : 'tableCell',
        attrs,
        content: ensureBlocks(mapCellBlocks(tcChildren, fillsWidth)),
      }

      if (vMerge === 'restart') {
        cell.attrs = { ...attrs, rowspan: 1 }
        openVMerges.set(gridCol, { cell })
      } else {
        // Plain cell ends any open vertical merge in this column.
        openVMerges.delete(gridCol)
      }

      cells.push(cell)
      gridCol += colspan
    }

    if (cells.length > 0) rowNodes.push({ type: 'tableRow', content: cells })
  }

  // Normalise rowspan=1 away (matches export: rowSpan omitted when 1).
  for (const r of rowNodes) {
    for (const c of r.content ?? []) {
      const a = c.attrs as Record<string, unknown> | undefined
      if (a && a.rowspan === 1) delete a.rowspan
      if (a && Object.keys(a).length === 0) delete c.attrs
    }
  }

  return { type: 'table', content: rowNodes.length ? rowNodes : [emptyRow()] }
}

/** w:tcPr/w:gridSpan/@w:val → colspan (default 1). */
function readGridSpan(tcPrChildren: OrderedNode[]): number {
  const gs = firstChild(tcPrChildren, 'w:gridSpan')
  const v = gs ? Number(orderedAttr(gs, 'w:val') ?? '1') : 1
  return Number.isFinite(v) && v >= 1 ? v : 1
}

/** w:tcPr/w:vMerge → 'restart' | 'continue' | null (no vertical merge). */
function readVMerge(tcPrChildren: OrderedNode[]): 'restart' | 'continue' | null {
  const vm = firstChild(tcPrChildren, 'w:vMerge')
  if (!vm) return null
  const val = (orderedAttr(vm, 'w:val') ?? '').toLowerCase()
  // Present with no val means "continue" per the OOXML spec.
  if (val === 'restart') return 'restart'
  return 'continue'
}

/** True when column widths are effectively uniform (within a small tolerance),
 *  i.e. the exporter's even page distribution rather than author-set ratios. */
function columnsAreUniform(colWidths: number[]): boolean {
  const positive = colWidths.filter((w) => w > 0)
  if (positive.length <= 1) return true
  const min = Math.min(...positive)
  const max = Math.max(...positive)
  // Allow ~5% drift to absorb rounding in the even A4 distribution.
  return max - min <= Math.max(2, min * 0.05)
}

/** True when the table's tblPr declares a percentage width (`w:tblW type="pct"`). */
function isPercentWidthTable(tblPr: OrderedNode | null | undefined): boolean {
  if (!tblPr) return false
  const tblW = firstChild(kids(tblPr, 'w:tblPr'), 'w:tblW')
  if (!tblW) return false
  const type = orderedAttr(tblW, 'w:type')
  return type === 'pct'
}

/** Scale a set of px column widths so their sum equals the editor content
 *  width, preserving the relative ratios. No-op when the widths already meet or
 *  exceed the editor width (never shrink a table that is already wide enough). */
function scaleWidthsToEditor(colWidths: number[]): number[] {
  const total = colWidths.reduce((s, w) => s + (w > 0 ? w : 0), 0)
  if (total <= 0 || total >= EDITOR_CONTENT_WIDTH_PX) return colWidths
  const factor = EDITOR_CONTENT_WIDTH_PX / total
  return colWidths.map((w) => (w > 0 ? Math.round(w * factor) : w))
}

/** Grid-column widths in px from w:tblGrid/w:gridCol (twips). */
function readGridWidths(tblChildren: OrderedNode[]): number[] {
  const grid = firstChild(tblChildren, 'w:tblGrid')
  if (!grid) return []
  const out: number[] = []
  for (const col of kids(grid, 'w:tblGrid')) {
    if (orderedTag(col) !== 'w:gridCol') continue
    const w = Number(orderedAttr(col, 'w:w') ?? '0')
    out.push(Number.isFinite(w) && w > 0 ? twipsToPx(w) : 0)
  }
  return out
}

/** Sum the px widths this cell covers; [] when any covered column is unknown. */
function sumColWidths(colWidths: number[], gridCol: number, colspan: number): number[] {
  if (colWidths.length === 0) return []
  const widths: number[] = []
  for (let i = 0; i < colspan; i++) {
    const w = colWidths[gridCol + i]
    if (!w || w <= 0) return [] // unknown width — omit colwidth entirely
    widths.push(w)
  }
  return widths
}

/** A cell must contain at least one block; default to an empty paragraph. */
function ensureBlocks(blocks: PmNode[]): PmNode[] {
  return blocks.length ? blocks : [{ type: 'paragraph', content: [] }]
}

function emptyRow(): PmNode {
  return { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [] }] }] }
}
