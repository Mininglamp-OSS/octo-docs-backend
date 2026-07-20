/**
 * Docs notification via octo-server's internal notify API (docs-notify producer,
 * octo-server PR #584 — see .octospec/tasks/card-message-internal-dispatch/
 * docs-notify-contract.md in octo-server).
 *
 * When a doc access request is submitted, docs-backend POSTs a STRUCTURED
 * `docs_card` (raw fields only — no hand-built type-17 map, no template, no text
 * fallback) to `POST /v1/internal/notify`. octo-server authors the octo/v1 card
 * (attribution copy, deep-link, i18n; approve/deny buttons when request_id is set
 * and OCTO_DOCS_APPROVAL_CARD_ENABLED is on) and delivers it as a DM from the
 * shared notification bot, then returns `{delivered, filtered}`. Auth is the
 * docs-specific `X-Internal-Token: <OCTO_DOCS_NOTIFY_TOKEN>`, NOT a bot token.
 *
 * Contract invariants honoured here:
 *   - ONE recipient per request (`targets` single-element). We resolve the doc's
 *     approvers (owner + admins) and fan out one POST each.
 *   - Only `docs_card` is sent (never `payload`/`card`), and we never build a
 *     type-17 map — server rejects that (Decision 14).
 *   - Best-effort. Fired-and-forgotten from the submit route AFTER the request
 *     row is persisted; never throws back into it. The pull-based pending list
 *     remains the source of truth if a push fails.
 *   - Gated. If OCTO_DOCS_NOTIFY_TOKEN is unset the whole path is a silent no-op.
 */
import { config } from '../../config/env.js'
import { getOctoIdentity } from '../../auth/octoIdentity.js'
import { docMemberRepo } from '../../db/repos/docMemberRepo.js'
import { ROLE_ADMIN } from '../../permission/role.js'

const INTERNAL_NOTIFY_PATH = '/v1/internal/notify'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const KIND_ACCESS_REQUESTED = 'access_requested'
/** Abort a single notify POST after this long so a hung octo-server can't pin
 *  the best-effort call open. Comfortably above a healthy server's p99. */
const NOTIFY_TIMEOUT_MS = 5000

/** octo-server DocsCardFields (raw fields only; server owns copy/layout/link). */
interface DocsCardBody {
  doc_id: string
  /** Required by access_requested v2; the docs-domain idempotency/CAS key. When
   *  present (+ OCTO_DOCS_APPROVAL_CARD_ENABLED on the server) the card renders
   *  approve/deny buttons instead of the plain 查看详情 link. */
  request_id: string
  kind: string
  title: string
  actor_name: string
  /** Requester uid. When actor_name is empty octo-server resolves the display
   *  name from this server-side (identity authority), so a valid OCTO_SERVER_TOKEN
   *  is not required for the name to render. */
  actor_uid: string
  excerpt: string
  updated_at: string
}

/** octo-server NotifyResp. */
interface NotifyResp {
  delivered: string[]
  filtered: Record<string, string>
}

export interface AccessRequestNotifyParams {
  docId: string
  /** The access request row id — carried as request_id (approval CAS key). */
  requestId: string
  spaceId: string
  ownerId: string
  title: string
  /** The uid that submitted the request (excluded from recipients + used as actor). */
  requesterUid: string
  /** Free-text reason (already trimmed/capped at 512 by the caller). */
  reason: string
}

/**
 * Resolve the doc's approvers = owner + all admins, de-duplicated and with the
 * requester removed. Owner has no doc_member row, so it comes from doc_meta.
 */
async function resolveApprovers(docId: string, ownerId: string, requesterUid: string): Promise<string[]> {
  const members = await docMemberRepo.list(docId)
  const set = new Set<string>()
  if (ownerId) set.add(ownerId)
  for (const m of members) {
    if (Number(m.role) === ROLE_ADMIN) set.add(m.uid)
  }
  set.delete(requesterUid)
  return [...set]
}

/** Format a Date as `YYYY-MM-DD HH:mm` in local time (docs-backend timezone). */
function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** POST one docs_card notification to a single recipient. Returns true on delivery. */
async function postNotify(
  spaceId: string,
  recipientUid: string,
  docsCard: DocsCardBody,
  internalToken: string,
): Promise<boolean> {
  const url = `${config.octoIdentity.serverBaseUrl}${INTERNAL_NOTIFY_PATH}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), NOTIFY_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_TOKEN_HEADER]: internalToken,
        },
        body: JSON.stringify({
          space_id: spaceId,
          service: config.notify.service,
          targets: [recipientUid], // contract: single recipient per request
          actor_uid: '',
          docs_card: docsCard,
        }),
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[octo-docs] docs-notify send failed (network)', { recipientUid, err: String(err) })
      return false
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[octo-docs] docs-notify rejected', { recipientUid, status: res.status })
      return false
    }
    // Only `delivered[]` counts as truly sent; `filtered` entries (not_space_member
    // / busy / dispatch_failed / …) are the caller's to retry per business rules.
    // The body read stays inside the AbortController window so a trickled/hung
    // response body is bounded by the same NOTIFY_TIMEOUT_MS, not just connect.
    const body = (await res.json().catch(() => null)) as NotifyResp | null
    return !!body && Array.isArray(body.delivered) && body.delivered.includes(recipientUid)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Notify the doc's owner+admins that a member requested access. Best-effort and
 * self-contained: resolves approvers, resolves the requester's display name once,
 * and fans out one POST per recipient. NEVER throws — all failures are logged and
 * swallowed so the submit route's 201 is unaffected. Returns the number of cards
 * actually delivered (for tests/metrics).
 */
export async function notifyDocAccessRequested(p: AccessRequestNotifyParams): Promise<number> {
  const { docsToken } = config.notify
  if (!docsToken) {
    // Outbound notify not configured — the pull-based pending list still works.
    return 0
  }

  try {
    const approvers = await resolveApprovers(p.docId, p.ownerId, p.requesterUid)
    if (approvers.length === 0) return 0

    // Requester display name for the "X 申请访问" attribution; empty is allowed
    // (octo-server falls back to 有人/Someone). getUser never throws — it returns
    // null on any lookup failure, including when no service token is configured.
    let actorName = ''
    try {
      const user = await getOctoIdentity().getUser(p.requesterUid)
      actorName = user?.name ?? ''
    } catch {
      actorName = ''
    }

    const docsCard: DocsCardBody = {
      doc_id: p.docId,
      request_id: p.requestId,
      kind: KIND_ACCESS_REQUESTED,
      title: p.title,
      actor_name: actorName,
      actor_uid: p.requesterUid,
      excerpt: p.reason,
      updated_at: formatTimestamp(new Date()),
    }

    const results = await Promise.all(
      approvers.map((uid) => postNotify(p.spaceId, uid, docsCard, docsToken)),
    )
    return results.filter(Boolean).length
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] docs-notify access-request failed', { docId: p.docId, err: String(err) })
    return 0
  }
}
