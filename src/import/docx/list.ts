/**
 * List reconstruction (commit ③): flat OOXML list paragraphs → nested PM lists.
 *
 * This is the hard part red猫/大奔 flagged. In a .docx there is NO tree: a list
 * is a RUN of consecutive paragraphs, each carrying only w:numPr {numId, ilvl}
 * (or, for our exported task lists, a w14:checkbox content control + manual
 * indent — no numPr at all). The nesting is IMPLIED by ilvl. We rebuild the tree
 * with an explicit stack, handling the three failure modes:
 *
 *   - mixed ordered/bullet at the same level  -> close + reopen a list of the
 *     new kind (a level can't be both)
 *   - level jumps (ilvl 0 -> 2, skipping 1)   -> synthesise the missing
 *     intermediate list/item wrappers so the tree never breaks
 *   - task items                              -> a taskList of taskItems, keyed
 *     off the checkbox control, independent of numPr
 *
 * The builder is fed one "list line" at a time (already extracted from the body
 * walker) and flushed into a single top-level list node when the run ends.
 */
import type { PmNode } from './types.js'
import type { Numbering } from './numbering.js'

/** One list paragraph, pre-extracted by the body walker. */
export interface ListLine {
  /** Nesting level (w:numPr/w:ilvl, or derived indent for tasks). 0-based. */
  ilvl: number
  /** Resolved list kind for this line. */
  kind: 'ordered' | 'bullet' | 'task'
  /** For task lines: the checkbox state. */
  checked?: boolean
  /** The inline content of the paragraph (text/marks/hardBreak…). */
  inline: PmNode[]
}

interface Frame {
  /** The list node (bulletList/orderedList/taskList) at this depth. */
  list: PmNode
  /** The kind backing `list`. */
  kind: 'ordered' | 'bullet' | 'task'
  /** The level this frame represents. */
  ilvl: number
}

function listTypeFor(kind: 'ordered' | 'bullet' | 'task'): string {
  return kind === 'ordered' ? 'orderedList' : kind === 'task' ? 'taskList' : 'bulletList'
}

function itemTypeFor(kind: 'ordered' | 'bullet' | 'task'): string {
  return kind === 'task' ? 'taskItem' : 'listItem'
}

function newList(kind: 'ordered' | 'bullet' | 'task'): PmNode {
  return { type: listTypeFor(kind), content: [] }
}

function newItem(line: ListLine): PmNode {
  const para: PmNode = { type: 'paragraph', content: line.inline }
  if (line.kind === 'task') {
    return { type: 'taskItem', attrs: { checked: !!line.checked }, content: [para] }
  }
  return { type: 'listItem', content: [para] }
}

/** The last item node currently open in a frame's list (to attach nested lists). */
function lastItem(frame: Frame): PmNode | undefined {
  const items = frame.list.content!
  return items[items.length - 1]
}

/**
 * Build the top-level list node(s) from a run of consecutive list lines.
 * Returns an ARRAY because a run can contain several sibling top-level lists
 * (e.g. a bullet list immediately followed by an ordered list — a level can't
 * change kind, so they are distinct blocks). Empty input → empty array.
 */
export function buildList(lines: ListLine[]): PmNode[] {
  if (lines.length === 0) return []

  const roots: PmNode[] = []
  const stack: Frame[] = []

  const openFrame = (
    kind: 'ordered' | 'bullet' | 'task',
    ilvl: number,
    parentItem: PmNode | null,
  ): Frame => {
    const list = newList(kind)
    const frame: Frame = { list, kind, ilvl }
    if (parentItem) parentItem.content!.push(list)
    stack.push(frame)
    if (stack.length === 1) roots.push(list) // a fresh top-level list
    return frame
  }

  for (const line of lines) {
    // 1. Pop frames deeper than this line's level.
    while (stack.length > 0 && stack[stack.length - 1]!.ilvl > line.ilvl) {
      stack.pop()
    }

    // 2. Same level but different kind: close it (a level can't switch kind).
    if (stack.length > 0) {
      const top = stack[stack.length - 1]!
      if (top.ilvl === line.ilvl && top.kind !== line.kind) {
        stack.pop()
      }
    }

    // 3. Ensure a frame exists at exactly this level (handling level JUMPS).
    if (stack.length === 0) {
      for (let l = 0; l <= line.ilvl; l++) {
        const parentItem = l === 0 ? null : ensurePlaceholderItem(stack[stack.length - 1]!)
        openFrame(line.kind, l, parentItem)
      }
    } else {
      const top = stack[stack.length - 1]!
      if (top.ilvl < line.ilvl) {
        for (let l = top.ilvl + 1; l <= line.ilvl; l++) {
          const parentItem = ensurePlaceholderItem(stack[stack.length - 1]!)
          openFrame(line.kind, l, parentItem)
        }
      }
    }

    // 4. Append the item to the current (top) frame.
    stack[stack.length - 1]!.list.content!.push(newItem(line))
  }

  return roots
}

/**
 * Return the last item of the frame's list to hang a child list on; if the list
 * has no item yet (a level jump that skipped this level's own item), create an
 * empty placeholder item so the nested list has a valid parent.
 */
function ensurePlaceholderItem(frame: Frame): PmNode {
  const existing = lastItem(frame)
  if (existing) return existing
  const placeholder: PmNode =
    frame.kind === 'task'
      ? { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [] }] }
      : { type: 'listItem', content: [{ type: 'paragraph', content: [] }] }
  frame.list.content!.push(placeholder)
  return placeholder
}
