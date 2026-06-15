/**
 * Role definitions and numeric <-> string mappings (§4.2).
 *
 * doc_member.role is stored as TINYINT: 1=reader 2=writer 3=admin.
 * `none` is not stored — it is the absence of any membership row and a
 * non-owner identity (§4.2 resolveRole returns none).
 */

export type Role = 'reader' | 'writer' | 'admin'
export type ResolvedRole = Role | 'none'

export const ROLE_READER = 1
export const ROLE_WRITER = 2
export const ROLE_ADMIN = 3

const NUM_TO_ROLE: Record<number, Role> = {
  [ROLE_READER]: 'reader',
  [ROLE_WRITER]: 'writer',
  [ROLE_ADMIN]: 'admin',
}

const ROLE_TO_NUM: Record<Role, number> = {
  reader: ROLE_READER,
  writer: ROLE_WRITER,
  admin: ROLE_ADMIN,
}

export function roleFromNumber(n: number): Role | undefined {
  return NUM_TO_ROLE[n]
}

export function roleToNumber(role: Role): number {
  return ROLE_TO_NUM[role]
}

/** Numeric rank for comparison; `none` is 0 (§4.6 accept branches compare curRole vs invite.role). */
export function roleRank(role: ResolvedRole): number {
  return role === 'none' ? 0 : ROLE_TO_NUM[role]
}

/** True if `a` is at least as privileged as `b` (a >= b). */
export function roleAtLeast(a: ResolvedRole, b: ResolvedRole): boolean {
  return roleRank(a) >= roleRank(b)
}
