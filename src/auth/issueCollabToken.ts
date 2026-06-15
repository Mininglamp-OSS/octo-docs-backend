/**
 * collab-token issuance service (§4.4).
 *
 * Two-layer chain: octo session token (opaque) -> verify -> trusted uid ->
 * resolveRole (doc_member + owner) -> sign short-lived collab JWT.
 *
 * The document existence/status check is performed HERE (§4.1: "docMetaRepo
 * existence/status check moved forward to the issuance endpoint"), so the WS
 * onAuthenticate does not recompute it.
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
 *   - documentName invalid/whiteboard => 403
 *   - doc missing/deleted => 404
 *   - role === none => 403 (no token)
 */
export async function issueCollabToken(octoToken: string, documentName: string): Promise<IssueResult> {
  // Layer-1: octo identity -> trusted uid (never trust a client-supplied uid).
  const identity = await getOctoIdentity().verifyToken(octoToken)
  if (!identity) return { ok: false, status: 401, error: 'login_required' }
  const uid = identity.uid

  // Validate / parse documentName (reject whiteboard + malformed keys).
  let parsed
  try {
    parsed = parseDocumentName(documentName)
  } catch {
    return { ok: false, status: 403, error: 'forbidden' }
  }
  if (parsed.kind !== 'document') return { ok: false, status: 403, error: 'forbidden' }

  // Doc existence/status + folder/key consistency (§4.1/§8.1 invariant).
  const meta = await docMetaRepo.getByDocumentName(documentName)
  if (!meta || meta.status === 0) return { ok: false, status: 404, error: 'not_found' }
  if (parsed.folder !== meta.folder_id) return { ok: false, status: 403, error: 'forbidden' }

  // Authorization: resolveRole = doc_member + owner.
  const role = await resolveRole(uid, meta.doc_id)
  if (role === 'none') return { ok: false, status: 403, error: 'forbidden' }

  // Sign with the document's current epoch (§4.4 / §4.5).
  const result = signCollabToken({
    uid,
    documentName,
    role,
    permission_epoch: meta.permission_epoch,
  })
  return { ok: true, result }
}
