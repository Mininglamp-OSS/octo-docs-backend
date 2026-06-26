/**
 * Hocuspocus Server instance (§2.1 / §2.2 / §4.1 / §5.1).
 *
 * - extension-database wired to the §3.2 persistence adapter (fetch/store).
 * - extension-redis for multi-instance pub/sub broadcast + document lock (§5.1/§5.3).
 * - extension-logger for structured logs.
 * - onAuthenticate implements §4.1 (verify token, epoch compare, role, readOnly).
 * - beforeHandleMessage does the per-principal write recheck (§4.5 step 4).
 * - beforeHandleAwareness validates presence identity + fields (§8.3.1).
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
import { handleAfterStore, handleBeforeUnload } from './autoSnapshot.js'

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

/**
 * §8.3.1 presence identity + field validation — source-scoped and NON-FATAL.
 *
 * `beforeHandleAwareness` hands us the awareness states decoded from THIS
 * source connection's inbound frame, keyed by Yjs clientId, as a MUTABLE map
 * (not the full broadcast set). So every entry here is something this very
 * connection is adding/updating; we validate only those and never touch other
 * peers' pre-existing presence — which is why legitimate multi-user cursors
 * flow through untouched.
 *
 * On any failure (impersonated identity, bad color, oversized/non-string name)
 * we DROP the offending clientId from the map — rejecting that part of the
 * frame. We MUST NOT throw: a malformed or impostor awareness frame must never
 * crash the process or break other users' live collaboration (the prior
 * implementation iterated the full broadcast set and threw, which crashed the
 * whole backend the moment a second user joined — a remotely triggerable DoS).
 */
export function validateAwarenessStates(
  states: Map<number, Record<string, unknown>>,
  ctx: AuthContext | undefined,
): void {
  if (!ctx) return // server-internal awareness (DirectConnection) carries no client ctx
  for (const [clientId, state] of states) {
    const user = (state as { user?: { id?: unknown; name?: unknown; color?: unknown } }).user
    if (!user) continue // non-presence awareness data — nothing to validate
    // identity must not be impersonated; color a valid hex (no CSS injection);
    // name a string <= 64 chars.
    const idOk = user.id === ctx.user.id
    const colorOk = typeof user.color === 'string' && COLOR_RE.test(user.color)
    const nameOk = typeof user.name === 'string' && user.name.length <= 64
    if (!idOk || !colorOk || !nameOk) {
      // Reject only this offending state; the rest of the frame is broadcast.
      states.delete(clientId)
    }
  }
}

export function createServer() {
  const server = new Server({
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
    // We use beforeHandleAwareness (not onAwarenessUpdate): its `states` map is
    // the source connection's OWN inbound frame (keyed by clientId) and is
    // mutable, so dropping an entry rejects just that part of the frame and the
    // broadcast reflects it — clean source-scoped, reject-the-frame semantics
    // with no way to crash the process. See validateAwarenessStates above.
    async beforeHandleAwareness(data) {
      validateAwarenessStates(data.states, data.context as AuthContext | undefined)
    },

    // A4 (§5.2): backend-autonomous KIND_AUTO snapshots. afterStoreDocument
    // fires after the authoritative state is persisted; the auto-snapshot
    // module owns the idle timer / min-interval fallback / Redis dedup. Gated
    // behind AUTO_SNAPSHOT_ENABLED (default off) inside the module.
    async afterStoreDocument(data) {
      await handleAfterStore(data.documentName, data.lastContext as AuthContext | undefined)
    },

    // A4 (§5.2): flush the last editing burst + clear the per-doc idle timer
    // when the document unloads.
    async beforeUnloadDocument(data) {
      await handleBeforeUnload(data.documentName)
    },
  })

  collabServer = server
  return server
}

/**
 * Process-local handle to the running Hocuspocus server, set by createServer().
 * Server-side write paths (e.g. REST version restore) need it to call
 * openDirectConnection and reach the LIVE in-memory document of connected
 * clients. Single-process scaffold; under multi-node owner routing (§5.2 / §9.1)
 * the restore must run on the document's owner node, same as agent writes (§7.3).
 */
let collabServer: Server | null = null

export function getCollabServer(): Server {
  if (!collabServer) throw new Error('collab server not initialized')
  return collabServer
}
