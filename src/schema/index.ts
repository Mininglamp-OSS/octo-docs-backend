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
 * carrying the v2 `image` node forward cumulatively. Bump this whenever the
 * node/mark set changes.
 */
export const SCHEMA_VERSION = 3

/**
 * Build the ProseMirror schema used for server-side Y.Doc <-> ProseMirror
 * conversion (§7.1). Kept intentionally minimal but structurally compatible
 * with a Tiptap StarterKit-style document (doc/paragraph/heading/image/text +
 * basic marks). Replace with the frozen `@octo/docs-schema` buildSchema() when
 * ready.
 */
export function buildSchema(): Schema {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block',
        content: 'inline*',
        parseDOM: [{ tag: 'p' }],
        toDOM: () => ['p', 0],
      },
      heading: {
        group: 'block',
        content: 'inline*',
        attrs: { level: { default: 1 } },
        defining: true,
        parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
        toDOM: (node) => [`h${node.attrs.level as number}`, 0],
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
        attrs: { color: { default: null } },
        parseDOM: [
          {
            tag: 'span',
            getAttrs: (dom) => {
              const el = dom as { style?: { color?: string } }
              const color = el.style?.color
              // A plain `<span>` with no color must NOT match, or this mark
              // would swallow every span on parse.
              if (!color) return false
              return { color }
            },
          },
        ],
        toDOM: (mark) => {
          const color = mark.attrs.color as string | null
          return ['span', color ? { style: `color: ${color}` } : {}, 0]
        },
      },
    },
  })
}
