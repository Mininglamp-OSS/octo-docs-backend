/**
 * Bot/human spreadsheet content read endpoint (Stage1, R-A independent surface).
 *
 * A spreadsheet stores its payload in flat Y.Maps ('sheet' cells + 'sheetDims'
 * column/row overrides) rather than the ProseMirror COLLAB_FIELD fragment, so it
 * does NOT round-trip through the PM schema. The rich-text body surface
 * (docContent.ts) rejects any non-'doc' target with 409 unsupported_doc_type, so
 * a sheet needs its own read route — reviewer decision R-A (a dedicated
 * /:docId/sheet endpoint) over reusing /content.
 *
 *   GET /:docId/sheet   reader — read the LIVE cells + dims + base version
 *
 * The route is mounted on BOTH the human /api/v1/docs chain and the bot
 * /v1/bot/docs chain (see app.ts), so each reads req.uid / req.spaceId from
 * whichever identity middleware ran. Stage2 (write) is intentionally NOT in this
 * router — the write interface shape and safety-contract are still gated on a
 * product decision.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { readLiveSheet } from '../../collab/liveSheetWrite.js'
import { encodeBaseVersion } from '../../collab/docBodyEdit.js'
import { decodeSheetSnapshot, decodeSheetDimsSnapshot } from '../../collab/versionRestore.js'
import { SheetSnapshotInvalidError } from '../../agent/sheetConversion.js'
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

export async function getDocSheetHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, req.spaceId!, 'reader')
  if (!guard) return
  if (!requireSheetDocType(res, guard.meta.doc_type)) return

  try {
    // Read the live authoritative state + its state vector, then decode with the
    // SAME validated primitives the version-restore preview uses (decodeSheet*),
    // so the read path and the preview path never drift on the {v,f,s} contract.
    const { state, baseSV } = await readLiveSheet(guard.meta.document_name)
    const sheetCells = decodeSheetSnapshot(state)
    const sheetDims = decodeSheetDimsSnapshot(state)

    // Stage1 large-sheet guard: bound the decoded payload. The live Y.Doc is
    // already capped at config.maxDocBytes so this decode + measure is bounded;
    // a sheet whose cell payload exceeds the read cap returns a clear
    // 413 sheet_too_large instead of an unbounded body. Paginated reads for
    // oversized sheets are deferred to a later stage.
    const payloadBytes = Buffer.byteLength(JSON.stringify({ sheetCells, sheetDims }))
    if (payloadBytes > config.sheetRead.maxCellBytes) {
      res.status(413).json({
        error: 'sheet_too_large',
        bytes: payloadBytes,
        limit: config.sheetRead.maxCellBytes,
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
      baseVersion: encodeBaseVersion(baseSV),
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
