/**
 * Hocuspocus Server instance (§2.1 / §2.2 / §4.1 / §5.1).
 *
 * - extension-database wired to the §3.2 persistence adapter (fetch/store).
 * - extension-redis for multi-instance pub/sub broadcast + document lock (§5.1/§5.3).
 * - extension-logger for structured logs.
 * - onAuthenticate implements §4.1 (verify token, epoch compare, role, readOnly).
 * - beforeHandleMessage does the per-principal write recheck (§4.5 step 4).
 * - onAwarenessUpdate validates presence identity + fields (§8.3.1).
 */
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { Redis } from '@hocuspocus/extension-redis'
import { Logger } from '@hocuspocus/extension-logger'
import { config } from '../config/env.js'
import { persistence } from './persistence.js'
import { authenticate, type AuthContext } from './authenticate.js'
import { connectionRegistry } from '../permission/connectionRegistry.js'
import { recheckCurrentRoleCached } from '../permission/recheck.js'
import { roleAtLeast } from '../permission/role.js'

/**
 * Per-node epoch watermark (§4.5 step 4): beforeHandleMessage reads this local
 * in-memory value, NOT Redis/DB per write. Refreshed by the epoch invalidation
 * subscriber (wired in index.ts). Keyed by documentName.
 */
const epochWatermark = new Map<string, number>()

export function setEpochWatermark(documentName: string, epoch: number): void {
  const cur = epochWatermark.get(documentName) ?? 0
  if (epoch > cur) epochWatermark.set(documentName, epoch)
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function createServer() {
  return new Server({
    name: `octo-docs-${config.hostname}`,
    port: config.hocuspocusPort,

    // connection limits & timeouts (§2.1)
    timeout: 30_000,
    maxDebounce: 10_000,
    debounce: 2_000,
    unloadImmediately: false, // single-writer affinity prereq (§5.2)

    extensions: [
      new Logger(),
      new Database({
        fetch: ({ documentName }) => persistence.fetch(documentName),
        // v4: pass lastContext through so store can write doc_meta.updated_by (P2-A).
        store: ({ documentName, state, lastContext }) =>
          persistence.store(documentName, state, lastContext as { user?: { id?: string } }),
      }),
      new Redis({
        host: config.redis.host,
        port: config.redis.port,
        prefix: config.redis.prefix, // multi-product key isolation (§2.1)
      }),
    ],

    // §4.1 onAuthenticate
    async onAuthenticate(data) {
      const ctx = await authenticate({
        token: data.token,
        documentName: data.documentName,
        connectionConfig: data.connectionConfig,
      })
      return ctx
    },

    // register the connection in the cross-node registry (§4.5 step 2)
    async connected(data) {
      const ctx = data.context as AuthContext
      setEpochWatermark(data.documentName, ctx.permission_epoch)
      await connectionRegistry.register({
        documentName: data.documentName,
        uid: ctx.user.id,
        node: config.hostname,
        connectionId: data.connection.socketId ?? data.socketId,
        role: ctx.role,
        permission_epoch: ctx.permission_epoch,
      })
    },

    async onDisconnect(data) {
      const ctx = data.context as AuthContext | undefined
      if (ctx) {
        await connectionRegistry.unregister(data.documentName, data.socketId)
      }
    },

    // §4.5 step 4: per-principal write recheck against the LOCAL epoch watermark.
    // Pure in-memory compare on the hot path; only stale connections hit recheck.
    async beforeHandleMessage(data) {
      const ctx = data.context as AuthContext | undefined
      if (!ctx) return // server-internal writes (DirectConnection) carry no client ctx

      const watermark = epochWatermark.get(data.documentName) ?? ctx.permission_epoch
      if (ctx.permission_epoch >= watermark) return // not stale => allow (no IO)

      // Stale: recheck this uid's CURRENT role (singleflight + short-TTL cache).
      const role = await recheckCurrentRoleCached(data.documentName, ctx.user.id)
      if (role === 'none' || !roleAtLeast(role, 'writer')) {
        // role actually dropped / revoked => reject this write & flip the conn.
        data.connection.readOnly = true
        throw new Error('Forbidden')
      }
      // Role not lowered (epoch advanced only due to someone else's change):
      // refresh the connection's epoch view in place and allow (P1-B).
      ctx.permission_epoch = watermark
    },

    // §8.3.1 awareness identity + field validation (MUST-level).
    async onAwarenessUpdate(data) {
      // onAwarenessUpdate carries the source connection (not a top-level
      // context); server-internal awareness has no client connection.
      const ctx = data.connection?.context as AuthContext | undefined
      if (!ctx) return
      for (const s of data.states) {
        const user = (s as { user?: { id?: unknown; name?: unknown; color?: unknown } }).user
        if (!user) continue
        // identity must not be impersonated.
        if (user.id !== ctx.user.id) throw new Error('awareness identity mismatch')
        // color must be a valid hex (prevents CSS injection).
        if (typeof user.color !== 'string' || !COLOR_RE.test(user.color)) {
          throw new Error('awareness color invalid')
        }
        // name must be a string <= 64 chars.
        if (typeof user.name !== 'string' || user.name.length > 64) {
          throw new Error('awareness name invalid')
        }
      }
    },
  })
}
