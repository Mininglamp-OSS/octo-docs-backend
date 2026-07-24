/**
 * Decision card `display` helpers (docs access approve/deny → octo-server).
 *
 * octo-server's registry result card reads `display.operator_name` and
 * `display.decided_at`. When docs-backend omits them, octo-server falls back to
 * the raw operator UID (rendered as an opaque hex) and a blank time. These
 * helpers let the card-action callback provide a human-readable operator name
 * and formatted decision time. Kept in their own module so the pure formatting
 * and the best-effort name resolution are unit-testable without importing the
 * whole callback route (env/repos/etc.).
 */
import { getOctoIdentity } from '../../auth/octoIdentity.js'

// Format acted_at to "YYYY-MM-DD HH:mm" (local), matching the docs-notify card
// timestamp format. acted_at may arrive in seconds or milliseconds depending on
// the client clock source, so normalize by magnitude (a 2020s epoch is ~1.7e9 s
// / ~1.7e12 ms). Empty on a missing / non-positive value.
export function formatDecidedAt(actedAt: number): string {
  if (!Number.isFinite(actedAt) || actedAt <= 0) return ''
  const ms = actedAt < 1e12 ? actedAt * 1000 : actedAt
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// buildDecisionDisplay assembles the octo-server card `display` map for a decided
// request: always the title, plus the operator's resolved display name and the
// formatted decision time when available. Resolving the name uses the same
// server-side identity path as the applicant name; getUser never throws, so on
// any miss we omit operator_name and octo-server keeps its existing UID fallback
// — no regression.
export async function buildDecisionDisplay(
  title: string,
  operatorUid: string,
  actedAt: number,
): Promise<Record<string, string>> {
  const display: Record<string, string> = { title: title || '文档访问申请' }
  try {
    const operator = await getOctoIdentity().getUser(operatorUid)
    const name = operator?.name?.trim()
    if (name) display.operator_name = name
  } catch {
    // best-effort; leave operator_name unset so octo-server keeps its fallback
  }
  const decidedAt = formatDecidedAt(actedAt)
  if (decidedAt) display.decided_at = decidedAt
  return display
}
