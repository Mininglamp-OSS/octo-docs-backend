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
}

export interface CollabTokenResult {
  token: string
  expiresAt: string // ISO8601
  role: Role
}

/** Sign a short-lived collab token (§4.4). */
export function signCollabToken(claims: CollabClaims): CollabTokenResult {
  const ttl = config.collabToken.ttlSeconds
  const token = jwt.sign(
    {
      uid: claims.uid,
      documentName: claims.documentName,
      role: claims.role,
      permission_epoch: claims.permission_epoch,
    },
    config.collabToken.secret,
    { algorithm: 'HS256', expiresIn: ttl },
  )
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + ttl) * 1000).toISOString()
  return { token, expiresAt, role: claims.role }
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
    (role !== 'reader' && role !== 'writer' && role !== 'admin') ||
    typeof permission_epoch !== 'number'
  ) {
    throw new Error('invalid collab token claims')
  }
  return { uid, documentName, role, permission_epoch }
}
