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
import { docViewHistoryRepo } from '../db/repos/docViewHistoryRepo.js'
import { config } from '../config/env.js'

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

  // Resolve the trusted DISPLAY NAME for this uid from the octo directory
  // (§4.7(b)), so the collab/presence layer can stamp the awareness frame's
  // user.name with a real name instead of the raw uid a not-yet-resolved client
  // publishes (XIN-694). The name is a separate field; uid stays the identity.
  //
  // verify already returns the caller's name in the common case (no extra IO).
  // Only when it is absent do we fall back to the per-uid directory lookup,
  // authenticated with the caller's own octo session token — the same token we
  // already hold. Both are best-effort: an unavailable name never blocks token
  // issuance (getUser swallows transport errors and returns null), it just
  // means this token carries no name and the presence layer keeps its existing
  // client-supplied-name behavior.
  let displayName = typeof identity.name === 'string' ? identity.name.trim() : ''
  if (displayName === '') {
    const profile = await getOctoIdentity().getUser(uid, octoToken)
    if (profile && typeof profile.name === 'string') displayName = profile.name.trim()
  }

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

  // FEAT-B recent-view fallback ingest (MF2, default-on). Every document open —
  // read-only INCLUDED — passes through here, so this is the reliable "open ==
  // viewed" seam even if the front-end never calls POST /docs/{id}/view. We now
  // hold a trusted uid + doc_id + space_id + role(!=none), everything the UPSERT
  // needs. Best-effort: fire-and-forget (never awaited) so it can't slow or fail
  // token issuance, and a failure only warns. It shares the (uid, doc_id) PK with
  // the explicit endpoint, so a front-end that ALSO calls view never double-counts.
  void docViewHistoryRepo
    .upsertViewWithPrune({
      uid,
      docId: meta.doc_id,
      spaceId: meta.space_id,
      retainCount: config.docView.retainCount,
      retainDays: config.docView.retainDays,
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[octo-docs] recent-view fallback ingest failed for ${meta.doc_id}:`, err)
    })

  // Sign with the document's current epoch (§4.4 / §4.5). The token carries the
  // exact connection documentName (incl. the `:wb:` whiteboard form) so the WS
  // handshake's documentName match (§4.1 step 2) holds.
  const result = signCollabToken({
    uid,
    documentName,
    role,
    permission_epoch: meta.permission_epoch,
    ...(displayName !== '' ? { name: displayName } : {}),
  })
  return { ok: true, result }
}
