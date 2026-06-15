/**
 * Pure decision function for the invite accept flow (§4.6 step 2 + step 4).
 *
 * Extracted from acceptInvite so the precise idempotency semantics (branches
 * a/b/c/d, exhaustion gate + re-accept exception, max_uses=0 unlimited) can be
 * unit-tested deterministically without a DB.
 */
import {
  INVITE_STATUS_ACTIVE,
  INVITE_STATUS_REVOKED,
  INVITE_STATUS_EXPIRED,
  INVITE_STATUS_EXHAUSTED,
} from '../../db/repos/docInviteRepo.js'
import { roleAtLeast, type Role, type ResolvedRole } from '../../permission/role.js'

export interface InviteState {
  status: number
  role: Role // already resolved from invite.role number
  maxUses: number
  usedCount: number
  expiresAtMs: number | null
}

export interface DecisionInput {
  invite: InviteState
  curRole: ResolvedRole // owner already mapped to 'admin'
  redeemed: boolean
  docExists: boolean
  nowMs: number
}

export type AcceptDecision =
  | { kind: 'gone' } // 410
  // branch a (curRole >= invite.role, incl owner) or b (curRole < invite.role,
  // no auto-upgrade): no write, return existing role.
  | { kind: 'noop'; role: ResolvedRole }
  // branch c: re-accept — rebuild member, epoch+1, NO used_count++, NO redemption.
  | { kind: 'reaccept'; role: Role }
  // branch d: first accept — insert member, insert redemption, used_count++, epoch+1.
  | { kind: 'first'; role: Role }

export function decideAcceptBranch(input: DecisionInput): AcceptDecision {
  const { invite, curRole, redeemed, docExists, nowMs } = input

  // step 2 gates.
  if (invite.status === INVITE_STATUS_REVOKED || invite.status === INVITE_STATUS_EXPIRED) {
    return { kind: 'gone' }
  }
  if (invite.expiresAtMs !== null && invite.expiresAtMs <= nowMs) {
    return { kind: 'gone' }
  }
  const exhausted =
    invite.status === INVITE_STATUS_EXHAUSTED ||
    (invite.maxUses > 0 && invite.usedCount >= invite.maxUses)
  // re-accept exception: an already-redeemed uid is not blocked by exhaustion.
  if (exhausted && !redeemed) {
    return { kind: 'gone' }
  }
  // a fresh (non-redeemed) accept still requires an active invite.
  if (invite.status !== INVITE_STATUS_ACTIVE && !redeemed) {
    return { kind: 'gone' }
  }
  if (!docExists) return { kind: 'gone' }

  // step 4 branches.
  // a: curRole exists && curRole >= invite.role (owner => admin lands here).
  if (curRole !== 'none' && roleAtLeast(curRole, invite.role)) {
    return { kind: 'noop', role: curRole }
  }
  // b: curRole exists && curRole < invite.role => no auto-upgrade via link.
  if (curRole !== 'none') {
    return { kind: 'noop', role: curRole }
  }
  // c: curRole none && redeemed => re-accept.
  if (redeemed) {
    return { kind: 'reaccept', role: invite.role }
  }
  // d: curRole none && !redeemed => first accept.
  return { kind: 'first', role: invite.role }
}
