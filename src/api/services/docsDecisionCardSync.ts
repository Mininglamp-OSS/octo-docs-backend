/**
 * Access-decision card sync (task docs-access-decision-card-sync).
 *
 * When an access request is approved/denied, drive EVERY approver's notification
 * card to a terminal state — not just the one the decider clicked. octo-server's
 * DocsActionFinalizer already terminalizes the clicked card; this closes the gap
 * for the sibling cards other approvers still hold.
 *
 * Primary path: in-place edit each sibling card via octo-server
 * POST /v1/internal/cards/mutate (server renders the SAME terminal card as the
 * finalizer, byte-identical). Fallback: if a mutate fails, re-notify that
 * approver with a fresh terminal card so no one keeps acting on a stale one.
 *
 * INVARIANTS (spec §Invariants):
 *   - Called only AFTER doc_access_request.decide() commits the transition, so a
 *     card can never show a terminal state while the row is still pending.
 *   - Best-effort: never throws; all failures are logged and swallowed so the
 *     decision's HTTP response and the grant are unaffected.
 *   - The 409 not_pending guard on approve/deny stays the authoritative safety
 *     net; this sync is an enhancement, not the sole protection.
 *   - On the card-callback path the decider's clicked card is terminalized by
 *     octo-server's finalizer, so it is skipped here. On the REST path there is
 *     no finalizer, so the decider is an approver holding a live card and IS
 *     terminalized here too (deciderCardHandledExternally distinguishes them).
 */
import { config } from '../../config/env.js'
import {
  docAccessNotifyCardRepo,
  type DocAccessNotifyCardRow,
} from '../../db/repos/docAccessNotifyCardRepo.js'

const INTERNAL_MUTATE_PATH = '/v1/internal/cards/mutate'
const INTERNAL_NOTIFY_PATH = '/v1/internal/notify'
const INTERNAL_TOKEN_HEADER = 'X-Internal-Token'
const KIND_ACCESS_GRANTED = 'access_granted'
const KIND_ACCESS_DENIED = 'access_denied'
/** Bound each best-effort POST so a hung octo-server can't pin the sync open. */
const SYNC_TIMEOUT_MS = 5000

export interface DecisionCardSyncParams {
  requestId: string
  spaceId: string
  docId: string
  title: string
  /** The admin who approved/denied. */
  deciderUid: string
  /**
   * Whether the decider's own card was already terminalized by an external actor
   * (octo-server's DocsActionFinalizer on the card-callback path). When true, the
   * decider's card row is skipped here to avoid a double mutate. When false/omitted
   * (the REST decision path — manage-members panel — where no finalizer runs), the
   * decider IS an approver and holds a live card, so it must be terminalized here
   * too, otherwise their own card stays actionable after they decide.
   */
  deciderCardHandledExternally?: boolean
  denied: boolean
  /** Reviewer deny reason surfaced on the terminal card; empty on approve. */
  denyReason?: string
}

/** POST helper with a bounded timeout. Returns the Response or null on network error. */
async function postJson(path: string, token: string, body: unknown): Promise<Response | null> {
  const url = `${config.octoIdentity.serverBaseUrl}${path}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SYNC_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(body),
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** In-place mutate one sibling card to terminal. Returns true when applied. */
async function mutateOneCard(
  p: DecisionCardSyncParams,
  kind: string,
  card: DocAccessNotifyCardRow,
  token: string,
): Promise<boolean> {
  const res = await postJson(INTERNAL_MUTATE_PATH, token, {
    space_id: p.spaceId,
    channel_id: card.channel_id,
    channel_type: card.channel_type,
    message_id: card.message_id,
    kind,
    doc_id: p.docId,
    title: p.title,
    deny_reason: p.denied ? (p.denyReason ?? '') : '',
  })
  return res !== null && res.ok
}

/** Fallback: send the approver a fresh terminal ("已处理") card. */
async function reNotifyTerminal(
  p: DecisionCardSyncParams,
  kind: string,
  card: DocAccessNotifyCardRow,
  token: string,
): Promise<void> {
  await postJson(INTERNAL_NOTIFY_PATH, token, {
    space_id: p.spaceId,
    service: config.notify.service,
    targets: [card.recipient_uid],
    actor_uid: '',
    docs_card: {
      doc_id: p.docId,
      request_id: p.requestId,
      kind,
      title: p.title,
      actor_name: '',
      excerpt: p.denied ? (p.denyReason ?? '') : '',
      updated_at: '',
    },
  })
}

/**
 * Drive all sibling approver cards for a decided request to terminal. Best-effort
 * and never throws — safe to fire-and-forget from the decision route.
 */
export async function syncDecisionCards(p: DecisionCardSyncParams): Promise<void> {
  const { docsToken } = config.notify
  if (!docsToken) return // outbound notify not configured — nothing to sync

  try {
    const kind = p.denied ? KIND_ACCESS_DENIED : KIND_ACCESS_GRANTED
    const cards = await docAccessNotifyCardRepo.listByRequest(p.requestId)
    // On the card-callback path octo-server's finalizer already terminalized the
    // decider's clicked card, so skip it here to avoid a double mutate. On the
    // REST path (manage-members panel) there is no finalizer, so the decider —
    // who is an approver holding a live card — must be terminalized too.
    const siblings = p.deciderCardHandledExternally
      ? cards.filter((c) => c.recipient_uid !== p.deciderUid)
      : cards
    if (siblings.length === 0) return

    await Promise.all(
      siblings.map(async (card) => {
        try {
          const applied = await mutateOneCard(p, kind, card, docsToken)
          if (!applied) {
            // Fallback so the approver still gets a terminal card.
            await reNotifyTerminal(p, kind, card, docsToken)
            return
          }
          // Best-effort audit; a failure here is harmless.
          await docAccessNotifyCardRepo
            .markTerminalized(p.requestId, card.recipient_uid)
            .catch(() => {})
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[octo-docs] decision card sync failed for one card', {
            requestId: p.requestId,
            err: String(err),
          })
        }
      }),
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[octo-docs] decision card sync failed', { requestId: p.requestId, err: String(err) })
  }
}
