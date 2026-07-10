/**
 * @octo/whiteboard-schema — element normalize rule set (XIN-16 §1/§4/§6).
 *
 * `normalizeElement` is the SINGLE shared rule definition the front-end binding
 * (local, render-time defence) and the back-end authoritative repair both call.
 * The only difference between the two sides is WHO may write the result back
 * (§4: server authoritative only); the rules themselves are identical here, so
 * the two sides never normalize to different shapes and fight each other.
 *
 * The function is PURE and DETERMINISTIC: same input element (+ same context) =>
 * same output, with no randomness and no clock reads. This is a precondition of
 * BE-M11 (cross-instance byte-identical repair) — any randomness here (e.g. a
 * random versionNonce fill) would make independent repairs diverge.
 *
 * Per-element scope (by design): version / versionNonce / numeric clamps / type
 * + id validation / dangling-ref pruning. Fractional-index REASSIGNMENT needs
 * the whole element set and is therefore completed by repair (repairElements),
 * not here — normalize only strips an invalid index to a clean absent state.
 */
import { generateKeyBetween, BASE_62_DIGITS } from 'fractional-indexing'
import { WB_ELEMENT_TYPES, FILE_BEARING_TYPES, hasReservedEntryKey } from './constants.js'
import type { WhiteboardElement, NormalizeContext } from './types.js'

/**
 * Base-62 alphabet an Excalidraw fractional-index (jitterbug) key is built from:
 * `0-9A-Za-z`. Every character of a valid key must come from this set — the same
 * charset the previous `INDEX_RE=/^[A-Za-z0-9]+$/` enforced.
 */
const BASE62_CHARS: ReadonlySet<string> = new Set(BASE_62_DIGITS.split(''))

/** Known numeric fields clamped to finite values; opacity additionally [0,100]. */
const FINITE_FIELDS = ['x', 'y', 'width', 'height', 'angle', 'strokeWidth', 'fontSize'] as const
const NON_NEGATIVE_FIELDS = new Set<string>(['width', 'height', 'strokeWidth', 'fontSize'])

/**
 * Deterministic 32-bit FNV-1a hash of a string, masked to a non-negative int.
 * Used to fill a missing/invalid `versionNonce` WITHOUT randomness so repair is
 * reproducible across instances.
 */
export function deterministicNonce(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    // FNV prime multiply via shifts (stay in 32-bit via >>> 0).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h & 0x7fffffff
}

/**
 * True if `v` is a valid Excalidraw fractional-index (jitterbug) key.
 *
 * Two gates, and BOTH must pass. This is the FE/BE-shared validity rule (XIN-16
 * §3) — the front-end `packages/whiteboard-schema/src/normalize.ts` must apply
 * the byte-identical rule so the two sides never disagree on what to strip:
 *
 *   1. charset — every character is in the base-62 alphabet `0-9A-Za-z`
 *      (`BASE_62_DIGITS`). This is the same charset the old `INDEX_RE` checked;
 *      it is kept as an explicit gate because `fractional-indexing`'s structural
 *      parse does NOT reject out-of-alphabet digits (e.g. it would accept
 *      `'a!b'`), so the charset gate must run first.
 *   2. structure — the string parses as a legal jitterbug order key. `fractional-
 *      indexing@4` does not export `validateOrderKey`, so we probe it through
 *      `generateKeyBetween(v, null)`, which validates its `a` argument and throws
 *      on a structurally illegal key. The head character fixes the integer-part
 *      length (A->27,...,Z->2 for the negative band; a->2,...,z->27 for the
 *      positive band) and the key must be at least that long — so the legacy
 *      synthetic key `r00000003` (head 'r' demands a 19-char integer part, got 9)
 *      is rejected here, where the old charset-only check let it through.
 */
export function isValidIndex(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false
  for (const ch of v) {
    if (!BASE62_CHARS.has(ch)) return false // gate 1: charset
  }
  try {
    generateKeyBetween(v, null) // gate 2: jitterbug structure (throws if illegal)
    return true
  } catch {
    return false
  }
}

function coerceVersion(v: unknown): number {
  return Number.isInteger(v) && (v as number) >= 1 ? (v as number) : 1
}

/**
 * Normalize a single element to canonical form, or return `null` if the element
 * is unrenderable and must be dropped (missing/blank id, non-string or
 * unknown-whitelist `type`, or — when `ctx.fileIds` is supplied — an image whose
 * `fileId` points at a file not present in the `files` container, §2).
 *
 * Unknown fields are preserved verbatim (§6). The input is never mutated.
 */
export function normalizeElement(
  el: unknown,
  ctx: NormalizeContext = {},
): WhiteboardElement | null {
  if (!el || typeof el !== 'object') return null
  const src = el as Record<string, unknown>
  if (typeof src.id !== 'string' || src.id.length === 0) return null
  if (typeof src.type !== 'string' || !WB_ELEMENT_TYPES.has(src.type)) return null
  // Reject reserved prototype keys before the clone: they are never a legitimate
  // element field and corrupt the plain-object read-back (ydoc.ts readEntry).
  if (hasReservedEntryKey(src)) return null

  // Clone (preserve unknown fields, §6); then correct known fields in place.
  const out: Record<string, unknown> = { ...src }

  const version = coerceVersion(src.version)
  out.version = version
  out.versionNonce = Number.isInteger(src.versionNonce)
    ? (src.versionNonce as number)
    : deterministicNonce(`${src.id}:${version}`)

  if ('isDeleted' in src) out.isDeleted = src.isDeleted === true

  // Numeric clamps: NaN/Infinity -> 0; non-negative fields floored at 0;
  // opacity clamped to [0,100].
  for (const f of FINITE_FIELDS) {
    if (f in out) {
      const n = typeof out[f] === 'number' && Number.isFinite(out[f]) ? (out[f] as number) : 0
      out[f] = NON_NEGATIVE_FIELDS.has(f) ? Math.max(0, n) : n
    }
  }
  if ('opacity' in out) {
    const o = typeof out.opacity === 'number' && Number.isFinite(out.opacity) ? out.opacity : 100
    out.opacity = Math.min(100, Math.max(0, o))
  }

  // Invalid/missing fractional index -> clean absent state; repairElements
  // assigns a deterministic key to indexless elements across the whole set.
  if (!isValidIndex(out.index)) delete out.index

  // Prune dangling references when context is supplied (§4.1).
  if (ctx.elementIds) {
    if (Array.isArray(out.boundElements)) {
      out.boundElements = (out.boundElements as Array<{ id?: unknown }>).filter(
        (b) => b && typeof b.id === 'string' && ctx.elementIds!.has(b.id),
      )
    }
    if (typeof out.frameId === 'string' && !ctx.elementIds.has(out.frameId)) {
      out.frameId = null
    }
    // A bound text whose container element was deleted is orphaned: clear the
    // dangling `containerId` (M-5). Same shape as the `frameId` rule above —
    // a ref to a non-surviving element is set to null, never deleted.
    if (typeof out.containerId === 'string' && !ctx.elementIds.has(out.containerId)) {
      out.containerId = null
    }
  }
  if (ctx.fileIds && FILE_BEARING_TYPES.has(src.type)) {
    // Image with a dangling file reference is unrenderable -> drop (§2.3).
    if (typeof src.fileId !== 'string' || !ctx.fileIds.has(src.fileId)) return null
  }

  return out as WhiteboardElement
}

/**
 * CAS arbitration (§1.1): does `incoming` supersede `current`?
 *   - higher `version` wins;
 *   - equal version -> smaller `versionNonce` wins;
 *   - otherwise treated as same state -> false (no write).
 * `current === undefined` (no existing element) => incoming wins.
 */
export function elementSupersedes(
  current: Pick<WhiteboardElement, 'version' | 'versionNonce'> | undefined,
  incoming: Pick<WhiteboardElement, 'version' | 'versionNonce'>,
): boolean {
  if (!current) return true
  if (incoming.version !== current.version) return incoming.version > current.version
  if (incoming.versionNonce !== current.versionNonce) return incoming.versionNonce < current.versionNonce
  return false
}
