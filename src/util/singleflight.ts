/**
 * Singleflight — coalesce concurrent calls keyed by a string so only one
 * in-flight execution runs per key; the rest await its result (§4.1 / §4.5
 * thundering-herd protection for currentEpoch / recheckCurrentRole).
 */
export class Singleflight<T> {
  private readonly inflight = new Map<string, Promise<T>>()

  async do(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = (async () => fn())().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }
}

/**
 * Tiny per-key TTL cache (process-local). Used to dampen repeated authoritative
 * reads within a short window (§4.1 recheck short-TTL cache).
 *
 * NOTE: `nowMs` is injectable so unit tests can drive expiry deterministically
 * (Date.now is not available inside workflow scripts; here it is fine for
 * runtime, but injection keeps the cache testable offline).
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (this.nowMs() >= entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: this.nowMs() + this.ttlMs })
  }

  delete(key: string): void {
    this.store.delete(key)
  }
}
