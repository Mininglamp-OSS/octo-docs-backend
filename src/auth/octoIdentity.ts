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
import { Singleflight, TtlCache } from '../util/singleflight.js'

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
   * (a-bot) Resolve a bot bearer token to its trusted bot uid, the bot's space,
   * and — when the bot has a human creator — that creator's uid. Calls
   * octo-server's already-existing POST /v1/auth/verify-bot, which validates the
   * token against the `robot` table, reverse-looks-up the bot's space from its
   * most recent active `space_member` row, and returns `owner_uid` (the bot's
   * `robot.creator_uid`). The space is therefore never client-supplied
   * (anti-spoof). `ownerUid` is omitted when the bot has no human creator (e.g. a
   * platform bot). Returns null when the token is missing/invalid (caller => 401 /
   * unauthorized).
   */
  verifyBot(token: string): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null>

  /**
   * (b) Look up a single user by uid. Returns null if the user does not exist
   * (used by §8.4 PUT members to reject ghost members => 404 user_not_found).
   *
   * octo-server's GET /v1/users/:uid requires auth, so a token is sent as the
   * `token` header: the configured service token when set, else the optional
   * authenticated caller's own octo session token.
   */
  getUser(uid: string, callerToken?: string): Promise<OctoUser | null>

  /**
   * (b-bot) Look up a single user by uid on the BOT path, authenticating with
   * the bot's own bearer token. Calls octo-server's already-existing bot
   * user-info route GET /v1/bot/user/info?uid=... with `Authorization: Bearer
   * <botToken>` (the authBot realm), not the AuthMiddleware-guarded
   * GET /v1/users/:uid route the human path uses. The 200-vs-404 signal is the
   * same anti ghost-member existence check: 200 -> OctoUser, 404 -> null.
   *
   * This is why the bot path no longer needs OCTO_SERVER_TOKEN: the bot resolves
   * the target user with its own token instead of a privileged service token.
   */
  getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null>

  /** (b) Batch profile lookup for awareness cursors (§4.7(b)). */
  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]>

  /**
   * (#64) Is `uid` an ACTIVE member of Space `spaceId`? Resolved server-side via
   * octo-server's POST /v1/auth/space-membership (the internal verify group,
   * same protection as /v1/auth/verify*), which answers the canonical predicate
   * `COUNT(*) FROM space_member WHERE space_id AND uid AND status=1 > 0`. Used to
   * honor the anyone_in_space share scope for HUMANS (bots derive membership from
   * their server-verified space, so they never call this).
   *
   * FAIL-CLOSED: any transport failure / non-200 / malformed body / unreachable
   * server returns `false` (treated as NOT a member), mirroring verifyToken /
   * verifyBot returning null on failure. A transient octo-server outage therefore
   * TIGHTENS access (denies share-derived reads/writes), never loosens it.
   */
  isSpaceMember(uid: string, spaceId: string): Promise<boolean>
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

  /**
   * Per-{uid,spaceId} coalescing + short-TTL cache for isSpaceMember (#64,
   * design §4.4). Bounds the extra octo-server QPS on hot anyone_in_space docs;
   * only positive/negative membership answers are cached, never a fail-closed
   * transport error (so a transient outage does not pin a `false` for the whole
   * TTL — the next call retries).
   */
  private readonly membershipSf = new Singleflight<boolean>()
  private readonly membershipCache = new TtlCache<boolean>(
    config.octoIdentity.membershipCacheTtlSeconds * 1000,
  )

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

  async verifyBot(token: string): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null> {
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
      | { bot_uid?: string; space_id?: string; owner_uid?: string }
      | null
    if (!body || typeof body.bot_uid !== 'string' || body.bot_uid === '') return null
    // The space is whatever octo-server reverse-resolved from the bot's active
    // space_member row; it is never a client-supplied value (anti-spoof).
    //
    // A bot with no resolvable space MUST NOT be authorized: reject it here
    // (return null, the unverified-identity signal) rather than passing an empty
    // spaceId downstream. Every doc guard scopes on req.spaceId, so an empty
    // space would silently defeat that scoping (empty === empty matches nothing
    // real, but bypasses the intended isolation). Enforcing it at the identity
    // layer means verifyBotMiddleware 401s a spaceless bot via its existing
    // null check, with no per-middleware special case, and keeps the invariant
    // "a verified bot identity always carries a real space" in one place.
    if (typeof body.space_id !== 'string' || body.space_id === '') return null
    // owner_uid is the bot's robot.creator_uid (the human who owns the bot).
    // octo-server returns '' for a bot with no human creator (e.g. a platform
    // bot); surface it only when it is a real uid so callers can skip the
    // owner-grant step cleanly.
    const ownerUid =
      typeof body.owner_uid === 'string' && body.owner_uid !== '' ? body.owner_uid : undefined
    return { uid: body.bot_uid, spaceId: body.space_id, ...(ownerUid ? { ownerUid } : {}) }
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

  async getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null> {
    // The bot resolves the target user with its own bearer token against the
    // authBot-guarded bot user-info route — no OCTO_SERVER_TOKEN needed. Never
    // logged. An empty token can never authenticate, so short-circuit to null.
    if (!botToken) return null
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/bot/user/info?uid=${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${botToken}` },
      })
    } catch {
      return null
    }
    // 404 is the anti ghost-member signal (user does not exist) => null.
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

  async isSpaceMember(uid: string, spaceId: string): Promise<boolean> {
    // A missing principal or space can never be a real active membership; short
    // out before any IO (also avoids caching a degenerate key).
    if (!uid || !spaceId) return false
    const key = `${uid} ${spaceId}`
    const cached = this.membershipCache.get(key)
    if (cached !== undefined) return cached
    return this.membershipSf.do(key, async () => {
      const member = await this.fetchIsSpaceMember(uid, spaceId)
      // Only cache a confirmed answer. A fail-closed `false` from a transport
      // error (fetchIsSpaceMember returns false on throw/non-200) is NOT cached
      // here — fetchIsSpaceMember distinguishes the two by returning null on
      // error, which we map to an uncached false.
      if (member !== null) this.membershipCache.set(key, member)
      return member ?? false
    })
  }

  /**
   * POST /v1/auth/space-membership with the service credential. Returns the
   * membership boolean, or null on any transport failure / non-200 / malformed
   * body so the caller can distinguish "confirmed not-a-member" (false) from
   * "could not confirm" (null => fail-closed, uncached). The service credential
   * is the same OCTO_SERVER_TOKEN header used by the other internal calls; the
   * endpoint sits in octo-server's internal verify group (network-restricted /
   * X-Internal-Key gated), so the human's session token is not the authorization.
   */
  private async fetchIsSpaceMember(uid: string, spaceId: string): Promise<boolean | null> {
    const token = config.octoIdentity.serviceToken || ''
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/auth/space-membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
        body: JSON.stringify({ space_id: spaceId, uid }),
      })
    } catch {
      // Authoritative source unreachable => cannot confirm => fail-closed.
      return null
    }
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { is_member?: unknown } | null
    if (!body || typeof body.is_member !== 'boolean') return null
    return body.is_member
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

  getUserAsBot(uid: string, botToken: string): Promise<OctoUser | null> {
    return this.delegate.getUserAsBot(uid, botToken)
  }

  verifyBot(token: string): Promise<{ uid: string; spaceId: string; ownerUid?: string } | null> {
    return this.delegate.verifyBot(token)
  }

  getUsers(uids: string[], callerToken?: string): Promise<OctoUser[]> {
    return this.delegate.getUsers(uids, callerToken)
  }

  isSpaceMember(uid: string, spaceId: string): Promise<boolean> {
    return this.delegate.isSpaceMember(uid, spaceId)
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
