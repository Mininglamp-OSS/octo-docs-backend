/**
 * collab-token issuance service (§4.4).
 *
 * Two-layer chain: octo session token (opaque) -> verify -> trusted uid ->
 * resolveRole (doc_member + owner) -> sign short-lived collab JWT.
 *
 * The document existence/status check is performed HERE (§4.1: "docMetaRepo
 * existence/status check moved forward to the issuance endpoint"), so the WS
 * onAuthenticate does not recompute it.
 *
 * Both documents and whiteboards are served. They differ only in how the key
 * resolves to a doc_meta row (appendix B):
 *   - document  `octo:{space}:{folder}:{doc}`        -> lookup by document_name
 *   - whiteboard `octo:{space}:{folder}:wb:{board}`  -> {board} IS the doc_id
 *     (a doc_meta row with doc_type='board'), so it resolves by doc_id.
 * Authorization (resolveRole = doc_member + owner) and signing are identical for
 * both — a board owner gets admin, a board member gets their stored role.
 */
import { signCollabToken, type CollabTokenResult } from './collabToken.js'
import { getOctoIdentity } from './octoIdentity.js'
import { parseDocumentName } from '../permission/documentName.js'
import { docMetaRepo } from '../db/repos/docMetaRepo.js'
import { resolveRole } from '../permission/resolveRole.js'

export type IssueResult =
  | { ok: true; result: CollabTokenResult }
  | { ok: false; status: 401 | 403 | 404; error: string }

/**
 * Issue a collab token for (octoToken, documentName).
 *   - octoToken invalid/missing  => 401
 *   - documentName malformed      => 403
 *   - doc/board missing/deleted   => 404
 *   - role === none               => 403 (no token)
 */
export async function issueCollabToken(octoToken: string, documentName: string): Promise<IssueResult> {
  // Layer-1: octo identity -> trusted uid (never trust a client-supplied uid).
  const identity = await getOctoIdentity().verifyToken(octoToken)
  if (!identity) return { ok: false, status: 401, error: 'login_required' }
  const uid = identity.uid

  // Validate / parse documentName (reject malformed keys; whiteboard keys are
  // accepted and routed by doc_id below).
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    return { ok: false, status: 403, error: 'forbidden' }
  }

  // Resolve the addressed doc_meta row. Documents are keyed by document_name (an
  // exact match implicitly validates the whole key); whiteboards are keyed by
  // doc_id (parsed.board), so the space/folder segments are validated explicitly
  // to keep the §8.1 key/row consistency invariant.
  let meta
  if (parsed.kind === 'whiteboard') {
    meta = await docMetaRepo.getByDocId(parsed.board)
    // The `:wb:` namespace addresses boards only — a non-board (or missing)
    // doc_id is "no such whiteboard".
    if (!meta || meta.status === 0 || meta.doc_type !== 'board') {
      return { ok: false, status: 404, error: 'not_found' }
    }
    if (parsed.space !== meta.space_id || parsed.folder !== meta.folder_id) {
      return { ok: false, status: 403, error: 'forbidden' }
    }
  } else {
    meta = await docMetaRepo.getByDocumentName(documentName)
    if (!meta || meta.status === 0) return { ok: false, status: 404, error: 'not_found' }
    if (parsed.folder !== meta.folder_id) return { ok: false, status: 403, error: 'forbidden' }
  }

  // Authorization: resolveRole = doc_member + owner (same model for docs/boards).
  const role = await resolveRole(uid, meta.doc_id)
  if (role === 'none') return { ok: false, status: 403, error: 'forbidden' }

  // Sign with the document's current epoch (§4.4 / §4.5). The token carries the
  // exact connection documentName (incl. the `:wb:` whiteboard form) so the WS
  // handshake's documentName match (§4.1 step 2) holds.
  const result = signCollabToken({
    uid,
    documentName,
    role,
    permission_epoch: meta.permission_epoch,
  })
  return { ok: true, result }
}
