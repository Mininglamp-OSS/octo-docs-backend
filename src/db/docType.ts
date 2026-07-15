/**
 * Document kind enum (FEAT-B type filter, XIN-1188).
 *
 * The three values here are the SINGLE source of truth for `doc_meta.doc_type` and the optional
 * `?type=` filter on the docs list / recent feed. They are authored in lockstep with the frontend
 * enum (octo-web packages/docs/src/pages/docsApi.ts `DOC_TYPES`) — the wire values MUST match
 * verbatim; never accept or emit a kind that isn't in this list.
 *
 * `board` is the whiteboard kind the create path already stamps (see routes/docs.ts
 * WHITEBOARD_DOC_TYPE); `doc` is the rich-text default; `sheet` is the Univer spreadsheet kind.
 */
export const DOC_TYPES = ['doc', 'sheet', 'board'] as const
export type DocType = (typeof DOC_TYPES)[number]

const DOC_TYPE_SET: ReadonlySet<string> = new Set(DOC_TYPES)

/** True when `v` is one of the canonical wire kinds. */
export function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && DOC_TYPE_SET.has(v)
}

/**
 * Normalize a repeated `?type=` query param into a de-duplicated, validated `DocType[]`.
 *
 * Unknown values are dropped rather than rejected: the candidate set is a fixed 3-value enum the
 * client writes directly, so a stray value is treated as "no such kind" and simply narrows nothing.
 * An empty result (no param, or only unknown values) means "no type filter" — the caller must then
 * apply NO `doc_type` predicate, preserving the exact pre-FEAT-B behavior (backward compatible).
 */
export function normalizeTypeFilter(input: unknown): DocType[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  const out: DocType[] = []
  for (const v of raw) {
    if (isDocType(v) && !out.includes(v)) out.push(v)
  }
  return out
}
