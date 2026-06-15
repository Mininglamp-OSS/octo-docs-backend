import { describe, it, expect, vi } from 'vitest'
import { Singleflight, TtlCache } from '../src/util/singleflight.js'

describe('Singleflight', () => {
  it('coalesces concurrent calls for the same key into one execution', async () => {
    const sf = new Singleflight<number>()
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 42
    })
    const [a, b, c] = await Promise.all([
      sf.do('k', fn),
      sf.do('k', fn),
      sf.do('k', fn),
    ])
    expect([a, b, c]).toEqual([42, 42, 42])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs again after the previous call settled', async () => {
    const sf = new Singleflight<number>()
    const fn = vi.fn(async () => 1)
    await sf.do('k', fn)
    await sf.do('k', fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('different keys run independently', async () => {
    const sf = new Singleflight<string>()
    const a = await sf.do('a', async () => 'A')
    const b = await sf.do('b', async () => 'B')
    expect([a, b]).toEqual(['A', 'B'])
  })
})

describe('TtlCache', () => {
  it('returns a value within TTL and expires it after (injected clock)', () => {
    let now = 1000
    const cache = new TtlCache<number>(100, () => now)
    cache.set('k', 7)
    expect(cache.get('k')).toBe(7)
    now = 1099
    expect(cache.get('k')).toBe(7)
    now = 1100
    expect(cache.get('k')).toBeUndefined() // expired at exactly ttl boundary
  })

  it('delete removes the entry', () => {
    const cache = new TtlCache<number>(1000)
    cache.set('k', 1)
    cache.delete('k')
    expect(cache.get('k')).toBeUndefined()
  })
})
