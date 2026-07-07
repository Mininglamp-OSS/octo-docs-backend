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
import { docMetaRepo } from '../db/repos/docMetaRepo.js'
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
  // M2: both document (4-seg) and whiteboard (5-seg `:wb:`) keys are served. The
  // permission subject is meta.doc_id either way; only malformed keys are
  // rejected (parseDocumentName throws -> caller fails closed).
  const parsed = parseDocumentName(documentName)
  const meta = await docMetaRepo.getByDocumentName(documentName)
  if (!meta || meta.status === 0) return 'none'
  // key/folder_id consistency invariant (§4.1): parsed folder must equal folder_id.
  if (parsed.folder !== meta.folder_id) return 'none'
  if (uid === meta.owner_id) return 'admin'
  const memberRole = await docMemberRepo.getRole(meta.doc_id, uid)
  return memberRole ?? 'none'
}
