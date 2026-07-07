/**
 * octo identity integration (§4.7).
 *
 * docs depends on octo for exactly two identity capabilities:
 *   (a) token -> trusted uid  (CacheTokenParser / AuthMiddleware / POST /v1/auth/verify)
 *   (b) uid   -> user info     (GET /v1/users/:uid; batch needs a small octo addition)
 *
 * This module exposes an injectable `OctoIdentity` interface with:
 *   - an HTTP impl (cross-service fallback calling octo's POST /v1/auth/verify
 *     and GET /v1/users/:uid), and
 *   - a middleware-style placeholder impl for the same-process mount, where uid
 *     would come from octo's AuthMiddleware via c.GetLoginUID() (§4.7(a)).
 */
import { config } from '../config/env.js'

export interface OctoUser {
  uid: string
  name: string
  avatar?: string
}

export interface OctoIdentity {
  /**
   * (a) Resolve an octo session token to a trusted uid. Returns null when the
   * token is missing/invalid (caller => 401 / login_required).
   */
  verifyToken(token: string): Promise<{ uid: string; name?: string } | null>

  /**
   * (a-bot) Resolve a bot bearer token to its trusted bot uid and the bot's
   * space. Calls octo-server's already-existing POST /v1/auth/verify-bot, which
   * validates the token against the `robot` table and server-side reverse-looks-up
   * the bot's space from its most recent active `space_member` row. The space is
   * therefore never client-supplied (anti-spoof). Returns null when the token is
   * missing/invalid (caller => 401 / unauthorized).
   */
  verifyBot(token: string): Promise<{ uid: string; spaceId: string } | null>

  /**
   * (b) Look up a single user by uid. Returns null if the user does not exist
   * (used by §8.4 PUT members to reject ghost members => 404 user_not_found).
   *
   * octo-server's GET /v1/users/:uid requires auth, so a token is sent as the
   * `token` header: the configured service token when set, else the optional
   * authenticated caller's own octo session token.
   */
  getUser(uid: string, callerToken?: string): Promise<OctoUser | null>

  /** (b) Batch profile lookup for awareness cursors (§4.7(b)). */
  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]>
}

/**
 * HTTP impl — cross-service fallback for when the docs backend runs as a
 * separate process (§4.7(a) "备选"). Calls octo's already-existing endpoints:
 *   POST /v1/auth/verify  -> { uid, name, role, owned_bots }
 *   GET  /v1/users/:uid   -> user detail
 *
 * TODO(§4.7(b)): batch profile uses the per-uid endpoint concurrently as a
 * stopgap until octo ships the thin `POST /v1/users/batch` (wraps GetUsers).
 */
export class HttpOctoIdentity implements OctoIdentity {
  constructor(private readonly baseUrl: string = config.octoIdentity.serverBaseUrl) {}

  async verifyToken(token: string): Promise<{ uid: string; name?: string } | null> {
    if (!token) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    } catch {
      // Authoritative identity source unreachable => treat as unverified.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { uid?: string; name?: string } | null
    if (!body || typeof body.uid !== 'string' || body.uid === '') return null
    return { uid: body.uid, name: body.name }
  }

  async verifyBot(token: string): Promise<{ uid: string; spaceId: string } | null> {
    if (!token) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/verify-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: token }),
      })
    } catch {
      // Authoritative identity source unreachable => treat as unverified.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { bot_uid?: string; space_id?: string }
      | null
    if (!body || typeof body.bot_uid !== 'string' || body.bot_uid === '') return null
    // The space is whatever octo-server reverse-resolved from the bot's active
    // space_member row; it is never a client-supplied value (anti-spoof).
    return { uid: body.bot_uid, spaceId: typeof body.space_id === 'string' ? body.space_id : '' }
  }

  async getUser(uid: string, callerToken?: string): Promise<OctoUser | null> {
    // octo-server requires auth on /v1/users/:uid: prefer a configured service
    // token, else fall back to the caller's own session token. Never logged.
    const token = config.octoIdentity.serviceToken || callerToken || ''
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/users/${encodeURIComponent(uid)}`, {
        headers: token ? { token } : {},
      })
    } catch {
      return null
    }
    if (res.status === 404) return null
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as
      | { uid?: string; name?: string; avatar?: string }
      | null
    if (!body || typeof body.uid !== 'string') return null
    return { uid: body.uid, name: body.name ?? '', avatar: body.avatar }
  }

  async getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    const results = await Promise.all(uids.map((u) => this.getUser(u, callerToken)))
    return results.filter((u): u is OctoUser => u !== null)
  }
}

/**
 * Middleware-style placeholder for the same-process mount (§4.7(a) primary
 * path). When docs endpoints are mounted behind octo-server's AuthMiddleware,
 * the trusted uid is taken from c.GetLoginUID() — there is no self-rolled
 * verification. This stub documents that path; wiring it requires running
 * inside the octo-server process.
 *
 * TODO(§4.7(a)): replace with a real bridge to octo AuthMiddleware /
 * CacheTokenParser once docs mounts in-process.
 */
export class MiddlewareOctoIdentity implements OctoIdentity {
  // Optional: when mounted in-process, a request-scoped uid would be injected
  // by the middleware. Kept as an HTTP delegate so this remains runnable.
  constructor(private readonly delegate: OctoIdentity = new HttpOctoIdentity()) {}

  async verifyToken(token: string): Promise<{ uid: string; name?: string } | null> {
    // In-process: octo AuthMiddleware would already have populated the uid.
    // Until wired, delegate to the HTTP introspection endpoint.
    return this.delegate.verifyToken(token)
  }

  getUser(uid: string, callerToken?: string): Promise<OctoUser | null> {
    return this.delegate.getUser(uid, callerToken)
  }

  verifyBot(token: string): Promise<{ uid: string; spaceId: string } | null> {
    return this.delegate.verifyBot(token)
  }

  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    return this.delegate.getUsers(uids, callerToken)
  }
}

let singleton: OctoIdentity | null = null

/** Resolve the configured OctoIdentity impl (OCTO_IDENTITY_MODE). */
export function getOctoIdentity(): OctoIdentity {
  if (!singleton) {
    singleton =
      config.octoIdentity.mode === 'middleware'
        ? new MiddlewareOctoIdentity()
        : new HttpOctoIdentity()
  }
  return singleton
}

/** Test seam: inject a stub identity. */
export function setOctoIdentity(impl: OctoIdentity): void {
  singleton = impl
}
