/**
 * resolveRole — document-autonomous role resolution (§4.2).
 *
 *   resolveRole(uid, docId):
 *     if uid === doc_meta(docId).owner_id: return admin   // owner => admin, not downgradable
 *     memberRole = doc_member(docId, uid).role            // single row
 *     return memberRole ?? none                           // no row => none
 *
 * No group inheritance, no max(...) union — a single doc_member lookup + owner
 * comparison. recheckCurrentRole (§4.1 stale branch) resolves documentName ->
 * doc_id first, then calls this.
 */
import { docMetaRepo, type DocMeta } from '../db/repos/docMetaRepo.js'
import { docMemberRepo } from '../db/repos/docMemberRepo.js'
import { parseDocumentName } from './documentName.js'
import type { ResolvedRole } from './role.js'

export async function resolveRole(uid: string, docId: string): Promise<ResolvedRole> {
  const meta = await docMetaRepo.getByDocId(docId)
  if (!meta) return 'none'
  if (uid === meta.owner_id) return 'admin' // owner implies admin (§4.2)
  const memberRole = await docMemberRepo.getRole(docId, uid)
  return memberRole ?? 'none'
}

/**
 * Shared documentName -> doc_meta resolver (§8.1 key/row consistency).
 *
 * Every server-side path that turns a *connection key* into its doc_meta row —
 * collab-token issuance (§4.4) and the WS write recheck (§4.1) — resolves it the
 * SAME way, keyed on document_name. Because a board's document_name IS its
 * 5-segment `:wb:` key, this one path serves documents and whiteboards alike and
 * replaces the doc_id lookup issuance used to special-case boards with. An exact
 * document_name match implicitly validates every segment; the explicit
 * space/folder compare stays as defense-in-depth against a row whose columns
 * disagree with its stored key. Returns the row, or null when the key is
 * malformed, absent, soft-deleted, or fails that consistency check.
 */
export async function resolveDocMetaByName(documentName: string): Promise<DocMeta | null> {
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    return null
  }
  const meta = await docMetaRepo.getByDocumentName(documentName)
  if (!meta || meta.status === 0) return null
  if (parsed.space !== meta.space_id || parsed.folder !== meta.folder_id) return null
  return meta
}

/**
 * recheckCurrentRole(documentName, uid) — §4.1 stale branch.
 *
 * Resolves the doc by document_name then applies resolveRole. Validates the
 * key shape & that the parsed folder matches doc_meta.folder_id (§4.1/§8.1
 * non-empty invariant). Returns 'none' if the doc does not exist.
 *
 * NOTE: callers wrap this with singleflight + short-TTL cache (§4.1 thundering
 * herd protection); this function itself is the authoritative DB read.
 */
export async function recheckCurrentRole(documentName: string, uid: string): Promise<ResolvedRole> {
  // M2: both document (4-seg) and whiteboard (5-seg `:wb:`) keys are served, via
  // the shared document_name resolver. The permission subject is meta.doc_id
  // either way; a malformed / absent / inconsistent key resolves to null and we
  // fail closed with 'none'.
  const meta = await resolveDocMetaByName(documentName)
  if (!meta) return 'none'
  if (uid === meta.owner_id) return 'admin'
  const memberRole = await docMemberRepo.getRole(meta.doc_id, uid)
  return memberRole ?? 'none'
}
