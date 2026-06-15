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

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect()
    client = null
  }
}
