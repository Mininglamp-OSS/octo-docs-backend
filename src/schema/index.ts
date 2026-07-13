/**
 * Local ProseMirror schema + shared collaboration field constant.
 *
 * TODO(contract §7.1 / appendix B): The contract references the FROZEN shared
 * package `@octo/docs-schema` (produced by the frontend, imported by backend +
 * Agent) for `buildSchema()` and `COLLAB_FIELD`. This local module is a
 * stand-in so the server-side conversion (§7.1) has a single source of truth
 * for the schema and field name. It MUST later be replaced by the frozen shared
 * package so the server schema stays byte-identical to the Tiptap front-end
 * configuration — schema drift causes conversion corruption / content loss.
 *
 * COLLAB_FIELD = 'default' is the Tiptap `extension-collaboration` default
 * XmlFragment field name (appendix B). Do NOT hardcode 'default' elsewhere —
 * always import this constant.
 */
import { Schema } from 'prosemirror-model'

export const COLLAB_FIELD = 'default'

/**
 * Schema version (§7.1 / §9.2). MUST stay in lockstep with the frontend
 * `@octo/docs-schema` package: the server schema and the Tiptap configuration
 * have to define the same node/mark set, or Y.Doc <-> ProseMirror conversion
 * drops or corrupts content. P1b bumped this from an implied 1 to 2 because the
 * `image` node was added below; the frontend half of the same coordination
 * (P1a) adds the matching Tiptap image extension and bumps the shared package.
 * P1a (v3) adds the `highlight` and `textStyle` marks below (SCHEMA-SPEC §3),
 * carrying the v2 `image` node forward cumulatively. P1a (v4) adds the four
 * table nodes (`table`/`tableRow`/`tableCell`/`tableHeader`, SCHEMA-SPEC §4),
 * carrying the v2 image node + v3 marks forward cumulatively. Bump this
 * whenever the node/mark set changes.
 *
 * v5-v15 LANDED (batch3 atomic co-land): the full @octo/docs-schema v15 node/
 * mark set is now mirrored here. The 发号 (version-number assignment) followed
 * the PM's single authoritative table — the front-end (Ploy) landed 5-13
 * (textAlign/underline/fontSize/sup-sub/emoji/mention/details/callout/math) and
 * the backend (Boris) owns the attr contract for 14=fileAttachment and
 * 15=bookmark. The backend does NOT self-assign: it registers the SAME numbers
 * the front-end uses. Numbers are monotonic and never reused — a cut item
 * retires its number (left as a gap). The cumulative additions are:
 *   - v5  textAlign — ATTR on heading/paragraph (default null; rides inline
 *         `style="text-align:…"`). No new node/mark.
 *   - v6  `underline` mark.
 *   - v7  fontSize — ATTR on the `textStyle` mark (so textStyle carries BOTH
 *         the v3 `color` and the v7 `fontSize` attr).
 *   - v8  `superscript` + `subscript` marks.
 *   - v9  `emoji` inline node — attr `name`. NON-atom in the dump (a
 *         content-less inline leaf): toDOM is span[data-type=emoji][data-name]
 *         with a literal `:${name}:` text child.
 *   - v10 `mention` inline atom — attrs id/label/mentionSuggestionChar (default
 *         "@")/type (default "user"); data-mention-suggestion-char +
 *         data-mention-type, class `octo-mention`.
 *   - v11 `details` block — `details` > `detailsSummary` + `detailsContent`.
 *   - v12 `callout` block container (attr `variant`; data-variant).
 *   - v13 `inlineMath` + `blockMath` nodes (attr `latex`).
 *   - v14 `fileAttachment` block atom (attrs attachId/fileName/mime/sizeBytes;
 *         data-attach-id/data-file-name/data-mime/data-size-bytes) — references
 *         a `doc_attachment` row (no inline bytes), like the `image` node.
 *   - v15 `bookmark` block atom (attrs url/title/description/image/siteName/
 *         fetchedAt; data-url/data-title/data-description/data-image/
 *         data-site-name/data-fetched-at) — EXACTLY the link-card OG endpoint
 *         out-params (POST /docs/:docId/link-card).
 *   - v16 fontFamily — ATTR on the `textStyle` mark, replicating the v7
 *         fontSize path verbatim (no new mark/node). textStyle now carries the
 *         v3 `color`, v7 `fontSize` and v16 `fontFamily` attrs, all riding the
 *         inline `<span style="…">` serialization (font-family added after
 *         color and font-size). SCHEMA_VERSION 16 is the shared front/back
 *         contract for this feature — the octo-web @octo/docs-schema half
 *         registers the SAME number; the backend does NOT self-assign.
 *
 * 14/15 land in the same lockstep as the frontend `@octo/docs-schema` /
 * SCHEMA-SPEC registration (node + attr byte alignment): the front-end Tiptap
 * nodes (FileAttachment.ts / Bookmark.ts) byte-align to these attr/data-*
 * names with no invented aliases, or Y.Doc <-> ProseMirror conversion drops
 * content. The standard nodes/marks (lists/tasklist/blockquote/codeBlock/
 * horizontalRule + the marks above) use their standard Tiptap/StarterKit
 * ProseMirror DOM serialization, consistent with the image/table nodes here.
 */
export const SCHEMA_VERSION = 16

/**
 * Shared attrs + DOM mapping for `tableCell` / `tableHeader` (SCHEMA-SPEC §4).
 *
 * Byte-aligned to prosemirror-tables (the schema @tiptap/extension-table
 * 2.27.2 builds on) so server-side Agent write-back (§7.1) round-trips tables
 * without loss. `getCellAttrs` mirrors prosemirror-tables' parse helper:
 * colspan/rowspan come from the matching attributes (default 1), colwidth from
 * a comma-separated `data-colwidth` attribute parsed to `number[]` (only when
 * its length matches colspan, else null). `setCellAttrs` mirrors the serialize
 * helper: colspan/rowspan are emitted only when != 1, and `data-colwidth` only
 * when colwidth is set.
 */
const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  colwidth: { default: null as number[] | null },
  // v15 byte-align: @tiptap/extension-table adds an `align` attr to cells
  // (default null). It rides `data-align` (emitted only when non-null) so the
  // cell alignment survives the Y.Doc <-> ProseMirror round-trip.
  align: { default: null as string | null },
}

function getCellAttrs(dom: unknown): {
  colspan: number
  rowspan: number
  colwidth: number[] | null
  align: string | null
} {
  // Structural typing: server build has no DOM lib types.
  const el = dom as { getAttribute(name: string): string | null }
  const widthAttr = el.getAttribute('data-colwidth')
  const widths =
    widthAttr && /^\d+(,\d+)*$/.test(widthAttr)
      ? widthAttr.split(',').map((s) => Number(s))
      : null
  const colspan = Number(el.getAttribute('colspan') ?? 1)
  return {
    colspan,
    rowspan: Number(el.getAttribute('rowspan') ?? 1),
    colwidth: widths && widths.length === colspan ? widths : null,
    align: el.getAttribute('data-align'),
  }
}

function setCellAttrs(node: { attrs: Record<string, unknown> }): Record<string, string> {
  const colspan = node.attrs.colspan as number
  const rowspan = node.attrs.rowspan as number
  const colwidth = node.attrs.colwidth as number[] | null
  const align = node.attrs.align as string | null
  const attrs: Record<string, string> = {}
  if (colspan !== 1) attrs.colspan = String(colspan)
  if (rowspan !== 1) attrs.rowspan = String(rowspan)
  if (colwidth) attrs['data-colwidth'] = colwidth.join(',')
  if (align != null) attrs['data-align'] = align
  return attrs
}

/**
 * Shared `textAlign` attr helpers for `paragraph` / `heading` (SCHEMA-SPEC §5,
 * @tiptap/extension-text-align). The attr defaults to null; it rides the inline
 * `style="text-align:…"` (Tiptap's TextAlign rendering) at parse + render, and
 * — most importantly — survives the Y.Doc <-> ProseMirror round-trip as a node
 * attr regardless of DOM serialization.
 */
function getTextAlignAttrs(dom: unknown): { textAlign: string | null } {
  const el = dom as {
    style?: { textAlign?: string }
    getAttribute(name: string): string | null
  }
  return { textAlign: el.style?.textAlign || el.getAttribute('data-text-align') || null }
}

function setTextAlignAttrs(node: { attrs: Record<string, unknown> }): Record<string, string> {
  const textAlign = node.attrs.textAlign as string | null
  return textAlign ? { style: `text-align: ${textAlign}` } : {}
}

/**
 * Bookmark url / og:image sanitizer (SCHEMA-SPEC §15, byte-aligned to the
 * front-end `sanitizeBookmarkUrl`): http/https ONLY (no mailto, no pseudo
 * schemes), no host whitelist (the bookmarked page + its thumbnail are external
 * by definition). Runs at parse AND render so a `javascript:`/`data:` URL can
 * never enter the Y.Doc or serialize back out. A relative/protocol-relative URL
 * resolves against a stable origin so the scheme check is meaningful server-side
 * (which has no `window.location`).
 */
const BOOKMARK_SCHEME_WHITELIST = new Set(['http:', 'https:'])

function sanitizeBookmarkUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw, 'https://octo.local')
    return BOOKMARK_SCHEME_WHITELIST.has(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

/**
 * Build the ProseMirror schema used for server-side Y.Doc <-> ProseMirror
 * conversion (§7.1). Mirrors the frozen `@octo/docs-schema` package at
 * SCHEMA_VERSION 15 — the FULL Tiptap node/mark set — so any front-end-authored
 * document round-trips through y-prosemirror and `PMNode.fromJSON(...).check()`
 * without loss. The standard nodes/marks use their standard Tiptap/StarterKit
 * ProseMirror DOM serialization; the self-built nodes (image/table/callout/
 * fileAttachment/bookmark) byte-align to the matching front-end node files.
 */
export function buildSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block',
        content: 'inline*',
        attrs: { textAlign: { default: null } },
        parseDOM: [{ tag: 'p', getAttrs: getTextAlignAttrs }],
        toDOM: (node) => ['p', setTextAlignAttrs(node), 0],
      },
      heading: {
        group: 'block',
        content: 'inline*',
        attrs: { textAlign: { default: null }, level: { default: 1 } },
        defining: true,
        parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
          tag: `h${level}`,
          getAttrs: (dom) => ({ ...getTextAlignAttrs(dom), level }),
        })),
        toDOM: (node) => [`h${node.attrs.level as number}`, setTextAlignAttrs(node), 0],
      },
      // Standard StarterKit-style block nodes brought in by the v15 co-land
      // (lists / task list / blockquote / codeBlock / horizontalRule). Each uses
      // its standard Tiptap ProseMirror DOM serialization, consistent with how
      // the image/table nodes below are written. The y-prosemirror round-trip
      // and PMNode.fromJSON().check() only care about the node name + attr set;
      // the toDOM/parseDOM mappings keep HTML import/export byte-aligned too.
      bulletList: {
        group: 'block list',
        content: 'listItem+',
        parseDOM: [{ tag: 'ul' }],
        toDOM: () => ['ul', 0],
      },
      orderedList: {
        group: 'block list',
        content: 'listItem+',
        attrs: { start: { default: 1 }, type: { default: null } },
        parseDOM: [
          {
            tag: 'ol',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              const start = el.getAttribute('start')
              return { start: start ? Number(start) : 1, type: el.getAttribute('type') }
            },
          },
        ],
        toDOM: (node) => {
          const start = node.attrs.start as number
          const type = node.attrs.type as string | null
          const attrs: Record<string, string> = {}
          if (start != null && start !== 1) attrs.start = String(start)
          if (type != null) attrs.type = type
          return ['ol', attrs, 0]
        },
      },
      listItem: {
        content: 'paragraph block*',
        defining: true,
        parseDOM: [{ tag: 'li' }],
        toDOM: () => ['li', 0],
      },
      taskList: {
        group: 'block list',
        content: 'taskItem+',
        parseDOM: [{ tag: 'ul[data-type="taskList"]' }],
        toDOM: () => ['ul', { 'data-type': 'taskList' }, 0],
      },
      taskItem: {
        content: 'paragraph block*',
        defining: true,
        attrs: { checked: { default: false } },
        parseDOM: [
          {
            tag: 'li[data-type="taskItem"]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return { checked: el.getAttribute('data-checked') === 'true' }
            },
          },
        ],
        toDOM: (node) => [
          'li',
          { 'data-type': 'taskItem', 'data-checked': node.attrs.checked ? 'true' : 'false' },
          0,
        ],
      },
      blockquote: {
        group: 'block',
        content: 'block+',
        defining: true,
        parseDOM: [{ tag: 'blockquote' }],
        toDOM: () => ['blockquote', 0],
      },
      codeBlock: {
        group: 'block',
        content: 'text*',
        marks: '',
        code: true,
        defining: true,
        attrs: { language: { default: null } },
        parseDOM: [
          {
            tag: 'pre',
            preserveWhitespace: 'full',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return { language: el.getAttribute('data-language') }
            },
          },
        ],
        toDOM: (node) => {
          const language = node.attrs.language as string | null
          return ['pre', language ? { 'data-language': language } : {}, ['code', 0]]
        },
      },
      horizontalRule: {
        group: 'block',
        parseDOM: [{ tag: 'hr' }],
        toDOM: () => ['hr'],
      },
      // hardBreak — inline `<br>` leaf (StarterKit). The JSON dump carries it as
      // an inline node (group "inline", non-atom) even though it is absent from
      // schemaNodesConst; include it so a soft line break round-trips.
      hardBreak: {
        group: 'inline',
        inline: true,
        selectable: false,
        parseDOM: [{ tag: 'br' }],
        toDOM: () => ['br'],
      },
      // Block image node (§3.2 / §3.5). The Y.Doc stores only a reference —
      // `attachId` (preferred) or a controlled `src` URL — NEVER base64, so
      // CRDT updates stay small (§3.5 step 3). Adding this node here is the
      // backend half of the @octo/docs-schema lockstep (see SCHEMA_VERSION);
      // it must match the frontend Tiptap image extension's attrs.
      image: {
        group: 'block',
        inline: false,
        atom: true,
        draggable: true,
        attrs: {
          attachId: { default: null },
          src: { default: null },
          alt: { default: null },
          title: { default: null },
          width: { default: null },
          align: { default: null },
        },
        parseDOM: [
          {
            tag: 'img[src], img[data-attach-id]',
            getAttrs: (dom) => {
              // `dom` is a DOM element at parse time; type it structurally so
              // this module needs no DOM lib types (server build has none).
              const el = dom as { getAttribute(name: string): string | null }
              return {
                attachId: el.getAttribute('data-attach-id'),
                src: el.getAttribute('src'),
                alt: el.getAttribute('alt'),
                title: el.getAttribute('title'),
                width: el.getAttribute('width'),
                align: el.getAttribute('data-align'),
              }
            },
          },
        ],
        toDOM: (node) => {
          const { attachId, src, alt, title, width, align } = node.attrs
          const attrs: Record<string, string> = {}
          if (attachId != null) attrs['data-attach-id'] = String(attachId)
          if (src != null) attrs['src'] = String(src)
          if (alt != null) attrs['alt'] = String(alt)
          if (title != null) attrs['title'] = String(title)
          if (width != null) attrs['width'] = String(width)
          if (align != null) attrs['data-align'] = String(align)
          return ['img', attrs]
        },
      },
      // v4 table nodes (SCHEMA-SPEC §4, P1a), byte-aligned to
      // @tiptap/extension-table 2.27.2 / prosemirror-tables so server-side
      // Agent write-back (§7.1) round-trips tables without loss. The v2 `image`
      // node and v3 `highlight`/`textStyle` marks are carried forward
      // cumulatively (v4 ⊇ v3 ⊇ v2 — additive, nothing removed). `table` is in
      // group 'block', so it nests under doc's 'block+'; cells hold 'block+',
      // so paragraphs/headings/images/tables can live inside them.
      table: {
        group: 'block',
        content: 'tableRow+',
        tableRole: 'table',
        isolating: true,
        parseDOM: [{ tag: 'table' }],
        toDOM: () => ['table', ['tbody', 0]],
      },
      tableRow: {
        content: '(tableCell | tableHeader)*',
        tableRole: 'row',
        parseDOM: [{ tag: 'tr' }],
        toDOM: () => ['tr', 0],
      },
      tableCell: {
        content: 'block+',
        attrs: cellAttrs,
        tableRole: 'cell',
        isolating: true,
        parseDOM: [{ tag: 'td', getAttrs: getCellAttrs }],
        toDOM: (node) => ['td', setCellAttrs(node), 0],
      },
      tableHeader: {
        content: 'block+',
        attrs: cellAttrs,
        tableRole: 'header_cell',
        isolating: true,
        parseDOM: [{ tag: 'th', getAttrs: getCellAttrs }],
        toDOM: (node) => ['th', setCellAttrs(node), 0],
      },
      // v9 emoji — inline leaf (@tiptap/extension-emoji). The dump has it as a
      // NON-atom inline node (spec.atom is unset; a content-less inline node is
      // a leaf either way) carrying the `name` (shortcode) attr. toDOM is a
      // `span[data-type="emoji"][data-name]` with a literal `:${name}:` text
      // child (the dump's children:[{text:":null:"}]); parse reads data-name.
      emoji: {
        group: 'inline',
        inline: true,
        attrs: { name: { default: null } },
        parseDOM: [
          {
            tag: 'span[data-type="emoji"]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return { name: el.getAttribute('data-name') }
            },
          },
        ],
        toDOM: (node) => {
          const name = node.attrs.name as string | null
          const attrs: Record<string, string> = { 'data-type': 'emoji' }
          if (name != null) attrs['data-name'] = name
          return ['span', attrs, `:${name ?? ''}:`]
        },
      },
      // v10 mention — inline atom (@tiptap/extension-mention). attrs id/label/
      // mentionSuggestionChar (default "@")/type (default "user"). The trigger
      // char rides data-mention-suggestion-char and the kind ('user'|'doc')
      // rides data-mention-type; the span carries the `octo-mention` class.
      mention: {
        group: 'inline',
        inline: true,
        atom: true,
        attrs: {
          id: { default: null },
          label: { default: null },
          mentionSuggestionChar: { default: '@' },
          type: { default: 'user' },
        },
        parseDOM: [
          {
            tag: 'span[data-type="mention"]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return {
                id: el.getAttribute('data-id'),
                label: el.getAttribute('data-label'),
                mentionSuggestionChar: el.getAttribute('data-mention-suggestion-char') || '@',
                type: el.getAttribute('data-mention-type') || 'user',
              }
            },
          },
        ],
        toDOM: (node) => {
          const id = node.attrs.id as string | null
          const label = node.attrs.label as string | null
          const suggestionChar = (node.attrs.mentionSuggestionChar as string) || '@'
          const type = (node.attrs.type as string) || 'user'
          const attrs: Record<string, string> = {
            class: 'octo-mention',
            'data-type': 'mention',
            'data-mention-suggestion-char': suggestionChar,
            'data-mention-type': type,
          }
          if (id != null) attrs['data-id'] = id
          if (label != null) attrs['data-label'] = label
          return ['span', attrs, `${suggestionChar}${label ?? ''}`]
        },
      },
      // v11 details — collapsible block (@tiptap/extension-details): a wrapper
      // (`details` > `detailsSummary` + `detailsContent`).
      details: {
        group: 'block',
        content: 'detailsSummary detailsContent',
        defining: true,
        attrs: { open: { default: false } },
        parseDOM: [
          {
            tag: 'details',
            getAttrs: (dom) => {
              const el = dom as { hasAttribute(name: string): boolean }
              return { open: el.hasAttribute('open') }
            },
          },
        ],
        toDOM: (node) => [
          'details',
          node.attrs.open ? { class: 'octo-details', open: 'open' } : { class: 'octo-details' },
          0,
        ],
      },
      detailsSummary: {
        content: 'text*',
        defining: true,
        parseDOM: [{ tag: 'summary' }],
        toDOM: () => ['summary', 0],
      },
      detailsContent: {
        content: 'block+',
        defining: true,
        parseDOM: [{ tag: 'div[data-type="detailsContent"]' }],
        toDOM: () => ['div', { 'data-type': 'detailsContent' }, 0],
      },
      // v12 callout — self-built block container (front-end Callout.ts). `variant`
      // (info/warn/tip/success) round-trips via data-variant.
      callout: {
        group: 'block',
        content: 'block+',
        defining: true,
        attrs: { variant: { default: 'info' } },
        parseDOM: [
          {
            tag: 'div[data-callout]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return { variant: el.getAttribute('data-variant') || 'info' }
            },
          },
        ],
        toDOM: (node) => {
          const variant = (node.attrs.variant as string) || 'info'
          return [
            'div',
            { 'data-callout': '', 'data-variant': variant, class: `octo-callout octo-callout-${variant}` },
            0,
          ]
        },
      },
      // v13 inlineMath / blockMath — KaTeX formula nodes
      // (@tiptap/extension-mathematics). Each carries a `latex` attr.
      inlineMath: {
        group: 'inline',
        inline: true,
        atom: true,
        attrs: { latex: { default: '' } },
        parseDOM: [
          {
            tag: 'span[data-type="inline-math"]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return { latex: el.getAttribute('data-latex') || '' }
            },
          },
        ],
        toDOM: (node) => [
          'span',
          { 'data-type': 'inline-math', 'data-latex': String(node.attrs.latex ?? '') },
        ],
      },
      blockMath: {
        group: 'block',
        atom: true,
        attrs: { latex: { default: '' } },
        parseDOM: [
          {
            tag: 'div[data-type="block-math"]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return { latex: el.getAttribute('data-latex') || '' }
            },
          },
        ],
        toDOM: (node) => [
          'div',
          { 'data-type': 'block-math', 'data-latex': String(node.attrs.latex ?? '') },
        ],
      },
      // v14 fileAttachment — self-built block atom (front-end FileAttachment.ts).
      // attrs attachId/fileName/mime/sizeBytes; each rides a data-* attribute
      // emitted ONLY when non-null (mirrors the image node's rule). sizeBytes is
      // a decimal STRING in the DOM, a number in the attr.
      fileAttachment: {
        group: 'block',
        atom: true,
        draggable: true,
        selectable: true,
        attrs: {
          attachId: { default: null },
          fileName: { default: null },
          mime: { default: null },
          sizeBytes: { default: null as number | null },
        },
        parseDOM: [
          {
            tag: 'div[data-file-attachment]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              const raw = el.getAttribute('data-size-bytes')
              const size = raw == null || raw === '' ? null : Number(raw)
              return {
                attachId: el.getAttribute('data-attach-id'),
                fileName: el.getAttribute('data-file-name'),
                mime: el.getAttribute('data-mime'),
                sizeBytes: size != null && Number.isFinite(size) ? size : null,
              }
            },
          },
        ],
        toDOM: (node) => {
          const { attachId, fileName, mime, sizeBytes } = node.attrs
          const attrs: Record<string, string> = {
            'data-file-attachment': '',
            class: 'octo-file-attachment',
          }
          if (attachId != null) attrs['data-attach-id'] = String(attachId)
          if (fileName != null) attrs['data-file-name'] = String(fileName)
          if (mime != null) attrs['data-mime'] = String(mime)
          if (sizeBytes != null) attrs['data-size-bytes'] = String(sizeBytes)
          return ['div', attrs]
        },
      },
      // v15 bookmark — self-built block atom (front-end Bookmark.ts). attrs
      // url/title/description/image/siteName/fetchedAt; each rides a data-*
      // attribute emitted ONLY when non-null. url/image are http/https-sanitized
      // at BOTH parse and render so a javascript:/data: URL can never enter or
      // leave the Y.Doc. The attr set is EXACTLY the link-card OG out-params.
      bookmark: {
        group: 'block',
        atom: true,
        draggable: true,
        selectable: true,
        attrs: {
          url: { default: null },
          title: { default: null },
          description: { default: null },
          image: { default: null },
          siteName: { default: null },
          fetchedAt: { default: null },
        },
        parseDOM: [
          {
            tag: 'div[data-bookmark]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return {
                url: sanitizeBookmarkUrl(el.getAttribute('data-url')),
                title: el.getAttribute('data-title'),
                description: el.getAttribute('data-description'),
                image: sanitizeBookmarkUrl(el.getAttribute('data-image')),
                siteName: el.getAttribute('data-site-name'),
                fetchedAt: el.getAttribute('data-fetched-at'),
              }
            },
          },
        ],
        toDOM: (node) => {
          const { url, title, description, image, siteName, fetchedAt } = node.attrs
          const attrs: Record<string, string> = { 'data-bookmark': '', class: 'octo-bookmark' }
          const safeUrl = sanitizeBookmarkUrl(url as string | null)
          const safeImage = sanitizeBookmarkUrl(image as string | null)
          if (safeUrl != null) attrs['data-url'] = safeUrl
          if (title != null) attrs['data-title'] = String(title)
          if (description != null) attrs['data-description'] = String(description)
          if (safeImage != null) attrs['data-image'] = safeImage
          if (siteName != null) attrs['data-site-name'] = String(siteName)
          if (fetchedAt != null) attrs['data-fetched-at'] = String(fetchedAt)
          return ['div', attrs]
        },
      },
      text: { group: 'inline' },
    },
    marks: {
      bold: {
        parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
        toDOM: () => ['strong', 0],
      },
      italic: {
        parseDOM: [{ tag: 'em' }, { tag: 'i' }],
        toDOM: () => ['em', 0],
      },
      // v1 standard marks brought in by the v15 co-land (strike/code/link), with
      // their standard Tiptap ProseMirror DOM serialization.
      strike: {
        parseDOM: [
          { tag: 's' },
          { tag: 'del' },
          { tag: 'strike' },
          { style: 'text-decoration', getAttrs: (v) => ((v as string) === 'line-through' ? null : false) },
        ],
        toDOM: () => ['s', 0],
      },
      code: {
        excludes: '_',
        parseDOM: [{ tag: 'code' }],
        toDOM: () => ['code', 0],
      },
      link: {
        attrs: {
          href: { default: null },
          target: { default: '_blank' },
          rel: { default: 'noopener noreferrer' },
          class: { default: null },
          title: { default: null },
        },
        inclusive: true,
        parseDOM: [
          {
            tag: 'a[href]',
            getAttrs: (dom) => {
              const el = dom as { getAttribute(name: string): string | null }
              return {
                href: el.getAttribute('href'),
                target: el.getAttribute('target'),
                rel: el.getAttribute('rel'),
                class: el.getAttribute('class'),
                title: el.getAttribute('title'),
              }
            },
          },
        ],
        toDOM: (mark) => {
          const href = mark.attrs.href as string | null
          const target = mark.attrs.target as string | null
          const rel = mark.attrs.rel as string | null
          const cls = mark.attrs.class as string | null
          const title = mark.attrs.title as string | null
          const attrs: Record<string, string> = {}
          if (href != null) attrs.href = href
          if (target != null) attrs.target = target
          if (rel != null) attrs.rel = rel
          if (cls != null) attrs.class = cls
          if (title != null) attrs.title = title
          return ['a', attrs, 0]
        },
      },
      // v3 marks (SCHEMA-SPEC §3, P1a): `highlight` + `textStyle`. Their
      // toDOM/parseDOM are byte-aligned to the frontend Tiptap output
      // (@tiptap/extension-highlight multicolor -> `<mark style="background-color:…">`
      // and @tiptap/extension-text-style + @tiptap/extension-color ->
      // `<span style="color:…">`) so server-side Agent write-back (§7.1)
      // round-trips them without loss. The v2 `image` node above is carried
      // forward cumulatively (v3 ⊇ v2 — additive, nothing removed).
      highlight: {
        attrs: { color: { default: null } },
        parseDOM: [
          {
            tag: 'mark',
            getAttrs: (dom) => {
              // Structural typing: server build has no DOM lib types.
              const el = dom as { style?: { backgroundColor?: string } }
              const color = el.style?.backgroundColor || null
              return { color }
            },
          },
          {
            style: 'background-color',
            getAttrs: (value) => ({ color: (value as string) || null }),
          },
        ],
        toDOM: (mark) => {
          const color = mark.attrs.color as string | null
          return ['mark', color ? { style: `background-color: ${color}` } : {}, 0]
        },
      },
      textStyle: {
        // v3 `color` + v7 `fontSize` + v16 `fontFamily` ride on the same
        // `textStyle` mark (@tiptap/extension-text-style + FontSize + FontFamily)
        // -> <span style="color:…; font-size:…; font-family:…">.
        attrs: { color: { default: null }, fontSize: { default: null }, fontFamily: { default: null } },
        parseDOM: [
          {
            tag: 'span',
            getAttrs: (dom) => {
              const el = dom as { style?: { color?: string; fontSize?: string; fontFamily?: string } }
              const color = el.style?.color || null
              const fontSize = el.style?.fontSize || null
              const fontFamily = el.style?.fontFamily || null
              // A plain `<span>` with none of color / font-size / font-family must
              // NOT match, or this mark would swallow every span on parse.
              if (!color && !fontSize && !fontFamily) return false
              return { color, fontSize, fontFamily }
            },
          },
        ],
        toDOM: (mark) => {
          const color = mark.attrs.color as string | null
          const fontSize = mark.attrs.fontSize as string | null
          const fontFamily = mark.attrs.fontFamily as string | null
          const styles: string[] = []
          if (color) styles.push(`color: ${color}`)
          if (fontSize) styles.push(`font-size: ${fontSize}`)
          if (fontFamily) styles.push(`font-family: ${fontFamily}`)
          return ['span', styles.length ? { style: styles.join('; ') } : {}, 0]
        },
      },
      // v6 underline + v8 superscript/subscript marks, standard Tiptap DOM.
      underline: {
        parseDOM: [
          { tag: 'u' },
          { style: 'text-decoration', getAttrs: (v) => ((v as string) === 'underline' ? null : false) },
        ],
        toDOM: () => ['u', 0],
      },
      superscript: {
        parseDOM: [
          { tag: 'sup' },
          { style: 'vertical-align', getAttrs: (v) => ((v as string) === 'super' ? null : false) },
        ],
        toDOM: () => ['sup', 0],
      },
      subscript: {
        parseDOM: [
          { tag: 'sub' },
          { style: 'vertical-align', getAttrs: (v) => ((v as string) === 'sub' ? null : false) },
        ],
        toDOM: () => ['sub', 0],
      },
    },
  })
}
