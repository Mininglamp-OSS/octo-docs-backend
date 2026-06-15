/**
 * Cross-node connection registry (§4.5 step 2).
 *
 * Each active collaboration connection registers
 *   { document_name, uid, node, connectionId, role, permission_epoch }
 * so that on a doc_member change a node can locate the connections to act on
 * (close 4403 / flip readOnly). Cleared on disconnect.
 *
 * Stored as a Redis hash per document: field = connectionId, value = JSON.
 */
import { getRedis, rkey } from '../db/redis.js'
import type { Role } from './role.js'

export interface RegisteredConnection {
  documentName: string
  uid: string
  node: string
  connectionId: string
  role: Role
  permission_epoch: number
}

function regKey(documentName: string): string {
  return rkey('conn', documentName)
}

export const connectionRegistry = {
  async register(entry: RegisteredConnection): Promise<void> {
    try {
      await getRedis().hset(regKey(entry.documentName), entry.connectionId, JSON.stringify(entry))
    } catch {
      /* registry is best-effort; beforeHandleMessage recheck is the backstop */
    }
  },

  async unregister(documentName: string, connectionId: string): Promise<void> {
    try {
      await getRedis().hdel(regKey(documentName), connectionId)
    } catch {
      /* best-effort */
    }
  },

  /** List connections for a document (optionally filtered to a uid). */
  async list(documentName: string, uid?: string): Promise<RegisteredConnection[]> {
    let all: Record<string, string> = {}
    try {
      all = await getRedis().hgetall(regKey(documentName))
    } catch {
      return []
    }
    const out: RegisteredConnection[] = []
    for (const raw of Object.values(all)) {
      try {
        const entry = JSON.parse(raw) as RegisteredConnection
        if (!uid || entry.uid === uid) out.push(entry)
      } catch {
        /* skip malformed */
      }
    }
    return out
  },
}
