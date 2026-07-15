/**
 * collab token sign / verify (§4.4).
 *
 * Layer-2 of the two-layer token chain: a docs-backend-signed, minute-level
 * short-lived JWT, minimal privilege, scoped to "this documentName + uid +
 * role + epoch". Used ONLY for the WS handshake (never reuse the long-lived
 * octo session token on the WS — §4.4).
 *
 * claims = { uid, documentName, role, permission_epoch, exp }.
 *
 * TODO(§4.4): dev uses an HS256 shared secret. Production should sign with an
 * asymmetric key (issuer/validator same authoritative source) per §4.5.
 */
import jwt from 'jsonwebtoken'
import { config } from '../config/env.js'
import type { Role } from '../permission/role.js'

export interface CollabClaims {
  uid: string
  documentName: string
  role: Role
  permission_epoch: number
  /**
   * Trusted display name for `uid`, resolved from the octo user directory at
   * issuance (§4.7(b)). Optional: absent when the directory could not supply a
   * name. Carried so the collab/presence layer can stamp the awareness frame's
   * `user.name` with a real name instead of the raw uid a not-yet-resolved
   * client publishes (XIN-694). Never the identity itself — `uid` stays the id.
   */
  name?: string
}

export interface CollabTokenResult {
  token: string
  expiresAt: string // ISO8601
  role: Role
  // Current permission epoch for the doc (§4.5). Mirrors the signed claim so the
  // client can seed its epoch without decoding the JWT (previously absent, which
  // forced the frontend to default to 0 — XIN-210/211).
  permission_epoch: number
  // Absolute public WS origin for the collab handshake (§4.4). Present only when
  // the backend has COLLAB_TOKEN_PUBLIC_WS_URL configured; omitted otherwise so
  // the client falls back to its build-time env during the compat phase.
  collabWsUrl?: string
  // Trusted display name resolved at issuance (§4.7(b)). Surfaced so the client
  // can seed its own presence name without a separate directory round-trip;
  // omitted when the directory supplied none (XIN-694).
  name?: string
}

/** Sign a short-lived collab token (§4.4). */
export function signCollabToken(claims: CollabClaims): CollabTokenResult {
  const ttl = config.collabToken.ttlSeconds
  // Only sign a name claim when the directory actually supplied one; an empty
  // string carries no information and would just bloat every frame.
  const name = typeof claims.name === 'string' && claims.name !== '' ? claims.name : undefined
  const token = jwt.sign(
    {
      uid: claims.uid,
      documentName: claims.documentName,
      role: claims.role,
      permission_epoch: claims.permission_epoch,
      ...(name !== undefined ? { name } : {}),
    },
    config.collabToken.secret,
    { algorithm: 'HS256', expiresIn: ttl },
  )
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString()
  const result: CollabTokenResult = {
    token,
    expiresAt,
    role: claims.role,
    permission_epoch: claims.permission_epoch,
  }
  // Only surface an absolute, configured WS origin; never emit an empty/relative
  // one (resolveCollabPublicWsUrl already normalised unset/malformed to '').
  if (config.collabToken.publicWsUrl !== '') {
    result.collabWsUrl = config.collabToken.publicWsUrl
  }
  if (name !== undefined) {
    result.name = name
  }
  return result
}

/**
 * Verify a collab token: signature + not-expired (§4.1 step 1). Throws on
 * invalid/expired signature (caller maps to 4401). Returns the parsed claims.
 */
export function verifyCollabToken(token: string): CollabClaims {
  const decoded = jwt.verify(token, config.collabToken.secret, { algorithms: ['HS256'] })
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('invalid collab token payload')
  }
  const d = decoded as Record<string, unknown>
  const uid = d.uid
  const documentName = d.documentName
  const role = d.role
  const permission_epoch = d.permission_epoch
  if (
    typeof uid !== 'string' ||
    typeof documentName !== 'string' ||
    (role !== 'reader' && role !== 'commenter' && role !== 'writer' && role !== 'admin') ||
    typeof permission_epoch !== 'number'
  ) {
    throw new Error('invalid collab token claims')
  }
  // name is optional and cosmetic — a non-string or empty claim is simply
  // dropped (never a rejection reason), so an old token minted before the
  // name claim existed verifies exactly as before.
  const name = d.name
  return {
    uid,
    documentName,
    role,
    permission_epoch,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
  }
}
