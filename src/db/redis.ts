/**
 * Shared ioredis client (§5 / §4.5).
 *
 * Redis is used as: real-time pub/sub broadcast bus (via extension-redis),
 * permission_epoch READ CACHE (authoritative value lives in DB, §4.5 P2-E),
 * and the cross-node connection registry (§4.5). Redis is NOT an authoritative
 * store and does NOT carry update catch-up (§5.3).
 */
import { Redis } from 'ioredis'
import { config } from '../config/env.js'

let client: Redis | null = null

export function getRedis(): Redis {
  if (!client) {
    client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    })
  }
  return client
}

/** Namespaced key helper so multiple products can share one Redis (§2.1 prefix). */
export function rkey(...parts: string[]): string {
  return [config.redis.prefix, ...parts].join(':')
}

/**
 * Best-effort short-lived lock via `SET key val NX PX ttlMs` (§5.5 L1).
 *
 * Returns true if THIS caller set the key (won the window), false if it was
 * already held. Used by the auto-snapshot dedup guard so that under multi-node
 * deployment only one node writes a given KIND_AUTO frame per window. The key
 * auto-expires after ttlMs — the window IS the throttle, so we never explicitly
 * release. A non-integer / non-positive ttl is coerced to a 1ms floor so the
 * SET never throws on a bad config value.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const px = Math.max(1, Math.floor(ttlMs))
  const res = await getRedis().set(key, '1', 'PX', px, 'NX')
  return res === 'OK'
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect()
    client = null
  }
}
