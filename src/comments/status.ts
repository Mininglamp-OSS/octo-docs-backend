/**
 * Comment adjudication lifecycle — numeric <-> string maps + transition table.
 *
 * doc_comment.status is stored as TINYINT and is meaningful ONLY on a thread
 * root (parent_id IS NULL), exactly like the legacy `resolved` flag was. It
 * drives a 4-state adjudication lifecycle:
 *
 *   open (0) ──approve(writer)──▶ approved (1) ──agent commit──▶ committed (3)
 *     └────────reject(writer)───▶ rejected (2)
 *
 *   open      = raised, awaiting adjudication (default for a new comment)
 *   approved  = editor approved; enters the agent's execution list
 *   rejected  = editor declined; kept for audit (留痕), never applied
 *   committed = the agent applied it to the doc body (kept for audit); terminal
 *
 * The stored number IS the rank here (unlike role.ts, no decoupling is needed):
 * the values were introduced together, so 0/1/2/3 can be used directly.
 *
 * `resolved` (the legacy boolean) survives as a DERIVED mirror for old clients:
 * resolved = status !== 'open'. `status` is the single source of truth.
 */

export type Status = 'open' | 'approved' | 'rejected' | 'committed'

export const STATUS_OPEN = 0
export const STATUS_APPROVED = 1
export const STATUS_REJECTED = 2
export const STATUS_COMMITTED = 3

const NUM_TO_STATUS: Record<number, Status> = {
  [STATUS_OPEN]: 'open',
  [STATUS_APPROVED]: 'approved',
  [STATUS_REJECTED]: 'rejected',
  [STATUS_COMMITTED]: 'committed',
}

const STATUS_TO_NUM: Record<Status, number> = {
  open: STATUS_OPEN,
  approved: STATUS_APPROVED,
  rejected: STATUS_REJECTED,
  committed: STATUS_COMMITTED,
}

export function statusFromNumber(n: number): Status | undefined {
  return NUM_TO_STATUS[n]
}

export function statusToNumber(status: Status): number {
  return STATUS_TO_NUM[status]
}

/** Type guard: is `v` one of the four lifecycle status strings? */
export function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_TO_NUM, v)
}

/**
 * Allowed transitions (from -> set of reachable to). Anything not listed is an
 * invalid transition and must be rejected (see setStatus / the route's 400
 * invalid_transition). `committed` is terminal: no outbound transitions.
 */
const ALLOWED_TRANSITIONS: Record<Status, ReadonlySet<Status>> = {
  open: new Set<Status>(['approved', 'rejected']),
  approved: new Set<Status>(['committed', 'open']),
  rejected: new Set<Status>(['open']),
  committed: new Set<Status>(),
}

/** True if `from -> to` is an allowed lifecycle transition. */
export function canTransition(from: Status, to: Status): boolean {
  return ALLOWED_TRANSITIONS[from].has(to)
}

/**
 * Thrown by the repo when a requested status transition is not allowed. The
 * route maps this to 400 invalid_transition (typed so it is caught precisely,
 * not swallowed by a generic 500).
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: Status,
    public readonly to: Status,
  ) {
    super(`invalid transition: ${from} -> ${to}`)
    this.name = 'InvalidTransitionError'
  }
}
