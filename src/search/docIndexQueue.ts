/**
 * Full-text search index queue — PRODUCER side only.
 *
 * When a document's authoritative state is persisted (collab afterStoreDocument,
 * §3.3a of the search design), we enqueue a tiny "this doc changed" signal so a
 * separate indexer can later re-read the latest body and upsert it into
 * OpenSearch. The queue deliberately carries ONLY the documentName (no body,
 * no ACL) — the consumer re-reads authoritative data by key, which keeps the
 * message small and naturally coalesces a burst of edits into "read latest once".
 *
 * Transport: a plain Redis LIST over the shared ioredis client (LPUSH here at the
 * head; the consumer BRPOPs from the tail => FIFO). No new infrastructure, no
 * BullMQ. The consumer / indexer / OpenSearch wiring is intentionally out of
 * scope for this module.
 *
 * This is a best-effort side channel: a push failure must NEVER disturb the
 * collab store path, so callers fire-and-forget and every error is swallowed
 * after logging.
 */
import { getRedis, rkey } from '../db/redis.js'
import { parseDocumentName } from '../permission/documentName.js'

/** Redis LIST key holding pending index signals. Consumer BRPOPs the tail. */
export function docIndexQueueKey(): string {
  return rkey('search', 'body-queue')
}

/**
 * Kind of change that triggered the signal:
 *  - 'body' — content changed; consumer re-reads the body and re-indexes it.
 *  - 'acl'  — permission changed (owner/member/share/status); consumer re-reads
 *    the ACL fields and partial-updates them WITHOUT touching the body.
 */
export type DocIndexKind = 'body' | 'acl'

/**
 * Whether a documentName has a row in the search index (so an event about it is
 * worth enqueuing). 'document' (doc / sheet) and 'html' are indexed; whiteboards
 * carry no searchable text and are never indexed, so ACL/body events for them
 * are dropped. Parse failures => not indexed (best-effort gate, never throws).
 */
export function isSearchIndexedDoc(documentName: string): boolean {
  try {
    const kind = parseDocumentName(documentName).kind
    return kind === 'document' || kind === 'html'
  } catch {
    return false
  }
}

export interface DocIndexSignal {
  /** Canonical collab key `octo:<space>:<folder>:<doc>`; consumer parses/reads by it. */
  documentName: string
  kind: DocIndexKind
  /** Enqueue timestamp (ms), for the consumer's ordering / staleness checks. */
  ts: number
}

/**
 * Push a change signal onto the index queue. Best-effort: never throws — a Redis
 * hiccup here must not fail the surrounding store. Returns true if the push was
 * accepted by Redis, false if it was swallowed.
 */
export async function enqueueDocIndex(
  documentName: string,
  kind: DocIndexKind = 'body',
): Promise<boolean> {
  const signal: DocIndexSignal = { documentName, kind, ts: Date.now() }
  try {
    await getRedis().lpush(docIndexQueueKey(), JSON.stringify(signal))
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[octo-docs] search index-queue enqueue failed for ${documentName}:`, err)
    return false
  }
}
