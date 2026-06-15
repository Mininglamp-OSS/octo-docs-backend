/**
 * ID / token generators.
 *   doc_id        : business PK, prefix d_ (§3.4 / §8.4).
 *   invite_token  : high-entropy random string for invite URLs (§4.6).
 */
import { randomBytes } from 'node:crypto'

function rand(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/** Generate a doc_id like d_<24 hex>. */
export function newDocId(): string {
  return `d_${rand(12)}`
}

/** Generate a high-entropy invite token (§4.6, goes into the URL). */
export function newInviteToken(): string {
  return rand(24)
}

/** Generate an attachment id (§3.5 presign stub). */
export function newAttachId(): string {
  return `att_${rand(12)}`
}
