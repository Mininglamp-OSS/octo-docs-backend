/**
 * Live-document side of a bot/agent spreadsheet edit (design §7.3, mirrors
 * liveRestore.ts).
 *
 * A bot edits a sheet by writing cells onto the SAME live in-memory Y.Doc the
 * connected human clients are editing, so they see the change in real time and
 * the write is the single authoritative content write (never clobbered by a
 * stale client union — see liveRestore.ts for the full union-direction rationale).
 *
 * openDirectConnection bypasses onAuthenticate (server-internal, carries no
 * client ctx — beforeHandleMessage's `if (!ctx) return` lets it through). So the
 * CALLER must enforce authorization before invoking this (the agent layer decides
 * which bot may write which sheet), exactly as the restore service does.
 */
import type { Document } from '@hocuspocus/server'
import { getCollabServer } from './server.js'
import { applySheetCellsToYMap, SHEET_YMAP_FIELD, type SheetCell } from '../agent/sheetConversion.js'

/**
 * Apply a bot's cell edit onto the live sheet document and broadcast it.
 *
 * @param documentName canonical persistence/connection key for the sheet
 * @param uid          acting bot's user id (becomes doc_meta.updated_by on store)
 * @param cells        keyed cells to set; a null value deletes that cell
 */
export async function applySheetEditToLiveDoc(
  documentName: string,
  uid: string,
  cells: Record<string, SheetCell | null>,
): Promise<void> {
  const server = getCollabServer()
  const connection = await server.hocuspocus.openDirectConnection(documentName, { user: { id: uid } })
  try {
    await connection.transact((doc: Document) => {
      const ymap = doc.getMap<SheetCell>(SHEET_YMAP_FIELD)
      applySheetCellsToYMap(ymap, cells)
    })
  } finally {
    // Flushes the final store (awaited) and releases the direct connection.
    await connection.disconnect()
  }
}
