/**
 * Bot/human spreadsheet content endpoints (R-A independent surface).
 *
 * A spreadsheet stores its payload in flat Y.Maps ('sheet' cells + 'sheetDims'
 * column/row overrides) rather than the ProseMirror COLLAB_FIELD fragment, so it
 * does NOT round-trip through the PM schema. The rich-text body surface
 * (docContent.ts) rejects any non-'doc' target with 409 unsupported_doc_type, so
 * a sheet needs its own routes — reviewer decision R-A (a dedicated
 * /:docId/sheet endpoint) over reusing /content.
 *
 *   GET   /:docId/sheet   reader  — read the LIVE cells + dims + base version
 *   PATCH /:docId/sheet   writer  — batch cell set/delete under a strict
 *                                   If-Match(SV) optimistic-concurrency guard
 *
 * The routes are mounted on BOTH the human /api/v1/docs chain and the bot
 * /v1/bot/docs chain (see app.ts), so each reads req.uid / req.spaceId from
 * whichever identity middleware ran.
 *
 * The route gate (requireDocRole) is UX / a cheap 404 pass; on the write path the
 * authoritative role + permission_epoch recheck happens again under the row lock
 * inside editDocSheet, because the live write bypasses onAuthenticate — the same
 * safety contract the doc-body write (editDocBody) enforces (gate b).
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveSheet } from '../../collab/liveSheetWrite.js'
import { editDocSheet } from '../services/editDocSheet.js'
import { encodeBaseVersion, parseBaseVersion } from '../../collab/docBodyEdit.js'
import { decodeSheetSnapshot, decodeSheetDimsSnapshot } from '../../collab/versionRestore.js'
import { SheetSnapshotInvalidError, type SheetCell } from '../../agent/sheetConversion.js'
import {
  decodeSheetCursor,
  encodeSheetCursor,
  paginateSheetCells,
  InvalidSheetCursorError,
} from '../services/sheetPagination.js'
import { config } from '../../config/env.js'

export const docSheetRouter = Router()

/**
 * The only doc_type this sheet-content surface accepts. A 'doc' (rich text) or a
 * board/whiteboard stores a different Y.Doc shape, so reading it here would
 * surface an empty/nonsensical grid. Reject a non-'sheet' target BEFORE any
 * decode — the mirror of docContent's BODY_EDITABLE_DOC_TYPE guard.
 */
const SHEET_DOC_TYPE = 'sheet'

/**
 * Reject a target whose doc_type is not 'sheet'. Writes a 409
 * unsupported_doc_type and returns false when blocked.
 */
function requireSheetDocType(res: Response, docType: string): boolean {
  if (docType !== SHEET_DOC_TYPE) {
    res.status(409).json({ error: 'unsupported_doc_type' })
    return false
  }
  return true
}

// ── GET /:docId/sheet — read the live sheet (reader) ──────────────────────────
docSheetRouter.get('/:docId/sheet', getDocSheetHandler)

/** A single query value, taking the first when Express parsed a repeated param. */
function firstQueryValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

/**
 * Parse the caller's ?limit into a clamped positive integer, or an error to
 * send. A blank/absent limit yields the configured default; a non-integer or
 * non-positive value is a 400 invalid_limit (never silently coerced); a value
 * over the cap is clamped down to config.sheetRead.maxPageLimit.
 */
function parsePageLimit(raw: string | undefined): { limit: number } | { error: string } {
  if (raw === undefined || raw === '') return { limit: config.sheetRead.defaultPageLimit }
  // Reject anything that is not a clean base-10 integer (e.g. "10.5", "1e3", "abc").
  if (!/^[0-9]+$/.test(raw)) return { error: 'invalid_limit' }
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return { error: 'invalid_limit' }
  return { limit: Math.min(n, config.sheetRead.maxPageLimit) }
}

export async function getDocSheetHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader')
  if (!guard) return
  if (!requireSheetDocType(res, guard.meta.doc_type)) return

  const limitRaw = firstQueryValue(req.query.limit)
  const cursorRaw = firstQueryValue(req.query.cursor)
  // Pagination is opt-in: a caller passing neither param gets the exact Stage1
  // whole-sheet behavior (413 for an oversized grid), so existing callers and
  // small sheets are unaffected. Either param switches on paginated mode.
  const paginated = limitRaw !== undefined || cursorRaw !== undefined

  try {
    // Read the live authoritative state + its state vector, then decode with the
    // SAME validated primitives the version-restore preview uses (decodeSheet*),
    // so the read path and the preview path never drift on the {v,f,s} contract.
    const { state, baseSV } = await readLiveSheet(guard.meta.document_name)
    const sheetCells = decodeSheetSnapshot(state) as Record<string, SheetCell>
    const sheetDims = decodeSheetDimsSnapshot(state)
    const baseVersion = encodeBaseVersion(baseSV)

    if (paginated) {
      await respondPaginatedSheet(res, {
        docId: guard.meta.doc_id,
        sheetCells,
        sheetDims,
        baseVersion,
        limitRaw,
        cursorRaw,
      })
      return
    }

    // Legacy whole-sheet read (Stage1): bound the decoded payload. A sheet whose
    // cell payload exceeds the read cap returns a clear 413 sheet_too_large
    // instead of an unbounded body — now with a hint that a paginated read
    // (?limit=/?cursor=) can retrieve it page by page.
    const payloadBytes = Buffer.byteLength(JSON.stringify({ sheetCells, sheetDims }))
    if (payloadBytes > config.sheetRead.maxCellBytes) {
      res.status(413).json({
        error: 'sheet_too_large',
        bytes: payloadBytes,
        limit: config.sheetRead.maxCellBytes,
        hint: 'retry with ?limit=<n> to read this sheet in pages',
      })
      return
    }

    res.status(200).json({
      docId: guard.meta.doc_id,
      sheetCells,
      sheetDims,
      // The live state vector, base64. Carried so a later write can guard on it
      // for optimistic concurrency (Stage2); this read does not reuse a historic
      // versions snapshot.
      baseVersion,
    })
  } catch (err) {
    if (err instanceof SheetSnapshotInvalidError) {
      // A cell or dimension violated the {v,f,s} / c<idx>|r<idx> contract —
      // fail-closed rather than serializing arbitrary writer-controlled data.
      res.status(409).json({ error: 'sheet_snapshot_invalid' })
      return
    }
    res.status(500).json({ error: 'internal_error' })
  }
}

/**
 * Byte budget for a page's CELLS. maxCellBytes caps the grid payload — the same
 * `{ sheetCells, sheetDims }` object the whole-sheet read measures for its 413
 * (see getDocSheetHandler). The first page also carries sheetDims (returned once,
 * on page one), so budgeting only the cells against maxCellBytes let the first
 * page's cells + dims together exceed the cap — the per-page byte wall was
 * silently punched through whenever a sheet had non-trivial column/row overrides.
 *
 * Reserve everything in the grid payload EXCEPT the cells — the serialized dims
 * plus the fixed `{ "sheetCells": …, "sheetDims": … }` framing — so the whole
 * first page's grid payload (cells + dims) stays within maxCellBytes. Later pages
 * omit dims and get the full budget.
 *
 * Floored at 0: paginateSheetCells always emits at least its first cell (progress
 * guarantee), so even a pathologically large dims map still makes forward
 * progress rather than returning an empty, non-advancing page.
 */
function firstPageCellBudget(isFirstPage: boolean, sheetDims: Record<string, number>): number {
  if (!isFirstPage) return config.sheetRead.maxCellBytes
  // Envelope = the grid payload with an empty cell map: the dims plus the object
  // framing that will wrap the cells. Reserving it keeps cells + dims ≤ the cap.
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ sheetCells: {}, sheetDims }))
  return Math.max(0, config.sheetRead.maxCellBytes - envelopeBytes)
}

/**
 * Serve one page of a paginated sheet read. The cells are sliced from the
 * already-decoded snapshot in canonical (sheetId, row, col) order, bounded by
 * both the caller's ?limit and the per-page byte cap (maxCellBytes) so no page
 * exceeds the whole-sheet cap.
 *
 * Snapshot consistency: the cursor embeds the baseVersion the walk opened on.
 * A cursor whose token no longer matches the live baseVersion means a write
 * landed mid-walk — reject with 409 sheet_changed so the caller restarts from
 * page one against a single consistent snapshot (the read-side mirror of the
 * write path's If-Match guard). sheetDims is returned on the FIRST page only
 * (it describes the whole grid and need not repeat per page); subsequent pages
 * omit it.
 */
async function respondPaginatedSheet(
  res: Response,
  args: {
    docId: string
    sheetCells: Record<string, SheetCell>
    sheetDims: Record<string, number>
    baseVersion: string
    limitRaw: string | undefined
    cursorRaw: string | undefined
  },
): Promise<void> {
  const parsedLimit = parsePageLimit(args.limitRaw)
  if ('error' in parsedLimit) {
    res.status(400).json({ error: parsedLimit.error })
    return
  }

  let afterKey: string | null = null
  let isFirstPage = true
  if (args.cursorRaw !== undefined && args.cursorRaw !== '') {
    let cursor
    try {
      cursor = decodeSheetCursor(args.cursorRaw)
    } catch (err) {
      if (err instanceof InvalidSheetCursorError) {
        res.status(400).json({ error: 'invalid_cursor' })
        return
      }
      throw err
    }
    // Drift guard: the snapshot the walk started on must still be live, or the
    // pages would stitch together inconsistent snapshots.
    if (cursor.v !== args.baseVersion) {
      res.status(409).json({ error: 'sheet_changed' })
      return
    }
    afterKey = cursor.k
    isFirstPage = false
  }

  const page = paginateSheetCells(
    args.sheetCells,
    afterKey,
    parsedLimit.limit,
    firstPageCellBudget(isFirstPage, args.sheetDims),
  )
  const nextCursor =
    page.hasMore && page.lastKey !== null
      ? encodeSheetCursor({ v: args.baseVersion, k: page.lastKey })
      : null

  const body: Record<string, unknown> = {
    docId: args.docId,
    sheetCells: page.cells,
    baseVersion: args.baseVersion,
    hasMore: page.hasMore,
    nextCursor,
  }
  // Dims belong to the whole grid; return them once, on the first page.
  if (isFirstPage) body.sheetDims = args.sheetDims
  res.status(200).json(body)
}

/** Extract the base-version token from the If-Match header or the body mirror. */
function readBaseVersion(req: Request): string | null {
  const header = req.headers['if-match']
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw === 'string' && raw.trim() !== '') {
    // If-Match carries the token as a quoted entity-tag; strip the quotes.
    return raw.trim().replace(/^"(.*)"$/, '$1')
  }
  const bodyBase = (req.body ?? {}).baseVersion
  if (typeof bodyBase === 'string' && bodyBase !== '') return bodyBase
  return null
}

/**
 * A cell-edit batch: `{ cellKey: {v,f,s} | null }` (null = delete the cell).
 * Structural (shape-only) validation — a non-object, empty, or array batch is a
 * 400. Contract-level validation of each cell ({v,f,s} field types, key shape)
 * is deferred to validateSheetCellBatch in the service, which maps to 422.
 */
function validateCellsShape(cells: unknown): cells is Record<string, SheetCell | null> {
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return false
  const entries = Object.entries(cells as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(([, v]) => v === null || (typeof v === 'object' && !Array.isArray(v)))
}

/**
 * Request-shape bounds enforced BEFORE the no-lock batch validation (DoS gate),
 * mirroring docContent's checkOpsBounds. validateCellsShape only checks the
 * container; this caps magnitude so a ≤1mb body cannot force unbounded
 * validate/set work:
 *   - cell count            → 413 too_many_cells
 *   - single cell payload   → 413 cell_too_large
 * Byte-size is measured on the already-parsed (≤1mb) body, so the check itself
 * is bounded. Returns the error to send, or null when within bounds.
 */
function checkCellsBounds(
  cells: Record<string, SheetCell | null>,
): { status: number; error: string } | null {
  const entries = Object.entries(cells)
  if (entries.length > config.sheetWrite.maxCells) {
    return { status: 413, error: 'too_many_cells' }
  }
  for (const [, cell] of entries) {
    if (cell !== null && Buffer.byteLength(JSON.stringify(cell)) > config.sheetWrite.maxCellContentBytes) {
      return { status: 413, error: 'cell_too_large' }
    }
  }
  return null
}

// ── PATCH /:docId/sheet — batch cell edit (writer) ────────────────────────────
docSheetRouter.patch('/:docId/sheet', patchDocSheetHandler)

export async function patchDocSheetHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'writer')
  if (!guard) return
  // gate b: only a 'sheet' doc_type is writable here; the doc-body hard door
  // (docContent rejects 'sheet') is deliberately the mirror image — a sheet is
  // rejected there and accepted here.
  if (!requireSheetDocType(res, guard.meta.doc_type)) return

  const baseVersionRaw = readBaseVersion(req)
  if (baseVersionRaw === null) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  const cells = (req.body ?? {}).cells
  if (!validateCellsShape(cells)) {
    res.status(400).json({ error: 'invalid_body' })
    return
  }
  // Fail-fast request-shape bounds (DoS gate) before any batch validation.
  const bounds = checkCellsBounds(cells)
  if (bounds) {
    res.status(bounds.status).json({ error: bounds.error })
    return
  }

  try {
    const result = await editDocSheet({
      uid: req.uid!,
      docId: guard.meta.doc_id,
      documentName: guard.meta.document_name,
      clientBaseVersion: parseBaseVersion(baseVersionRaw),
      cells,
      authorizedEpoch: guard.meta.permission_epoch,
    })
    if (result.ok) {
      res.status(200).json({
        docId: guard.meta.doc_id,
        bytes: result.bytes,
        baseVersion: result.baseVersion,
        newDocVersionSeq: result.newDocVersionSeq,
      })
      return
    }
    res.status(result.status).json({ error: result.error })
  } catch {
    res.status(500).json({ error: 'internal_error' })
  }
}
