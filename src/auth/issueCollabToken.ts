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
 * Both documents and whiteboards are served, resolved the SAME way — by
 * document_name — through the shared resolveDocMetaByName resolver (appendix B):
 *   - document  `octo:{space}:{folder}:{doc}`
 *   - whiteboard `octo:{space}:{folder}:wb:{board}`  (the board's document_name
 *     IS this 5-segment key; a board row is doc_type='board')
 * Authorization (resolveRole = doc_member + owner) and signing are identical for
 * both — a board owner gets admin, a board member gets their stored role.
 */
import { signCollabToken, type CollabTokenResult } from './collabToken.js'
import { getOctoIdentity } from './octoIdentity.js'
import { parseDocumentName } from '../permission/documentName.js'
import { resolveRole, resolveDocMetaByName } from '../permission/resolveRole.js'

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

  // Validate / parse documentName first so a structurally malformed key is a
  // 403 (distinct from a well-formed key that resolves to no row => 404).
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    return { ok: false, status: 403, error: 'forbidden' }
  }

  // Resolve the addressed doc_meta row through the SHARED document_name resolver
  // (same path documents and the WS recheck use). An exact document_name match
  // implicitly validates every segment, so there is no board-only doc_id branch
  // anymore. A null here means the well-formed key addresses no live row.
  const meta = await resolveDocMetaByName(documentName)
  if (!meta) return { ok: false, status: 404, error: 'not_found' }
  // The `:wb:` namespace addresses boards only — a resolved row that is not a
  // board (corrupt key/row pairing) is "no such whiteboard".
  if (parsed.kind === 'whiteboard' && meta.doc_type !== 'board') {
    return { ok: false, status: 404, error: 'not_found' }
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
