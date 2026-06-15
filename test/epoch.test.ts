import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake Redis (stateful) + mocked docMetaRepo for offline epoch testing.
const store = new Map<string, string>()
const redisGet = vi.fn(async (k: string) => store.get(k) ?? null)
const redisSet = vi.fn(async (k: string, v: string) => {
  store.set(k, v)
  return 'OK'
})
const redisDel = vi.fn(async (k: string) => {
  store.delete(k)
  return 1
})
const redisPublish = vi.fn(async () => 1)

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet, del: redisDel, publish: redisPublish }),
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getEpochByDocumentName: vi.fn(), bumpEpoch: vi.fn() },
}))

import { currentEpoch, refreshAndPublish, bumpEpoch } from '../src/permission/epoch.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

beforeEach(() => {
  store.clear()
  redisGet.mockClear()
  redisSet.mockClear()
  redisPublish.mockClear()
  vi.mocked(docMetaRepo.getEpochByDocumentName).mockReset()
  vi.mocked(docMetaRepo.bumpEpoch).mockReset()
})

describe('currentEpoch (§4.1 / §4.5)', () => {
  it('returns the Redis-cached value without hitting the DB', async () => {
    store.set('octo-docs:epoch:octo:s:f:d_hit', '5')
    const epoch = await currentEpoch('octo:s:f:d_hit')
    expect(epoch).toBe(5)
    expect(docMetaRepo.getEpochByDocumentName).not.toHaveBeenCalled()
  })

  it('on Redis miss falls back to DB and coalesces concurrent reads (singleflight)', async () => {
    vi.mocked(docMetaRepo.getEpochByDocumentName).mockImplementation(
      async () => new Promise((resolve) => setTimeout(() => resolve(9), 5)) as Promise<number>,
    )
    const [a, b] = await Promise.all([
      currentEpoch('octo:s:f:d_miss'),
      currentEpoch('octo:s:f:d_miss'),
    ])
    expect(a).toBe(9)
    expect(b).toBe(9)
    // singleflight: only ONE DB round-trip despite two concurrent callers.
    expect(docMetaRepo.getEpochByDocumentName).toHaveBeenCalledTimes(1)
  })

  it('throws (fail-closed) when the doc is unknown in DB', async () => {
    vi.mocked(docMetaRepo.getEpochByDocumentName).mockResolvedValue(null)
    await expect(currentEpoch('octo:s:f:d_unknown')).rejects.toThrow()
  })
})

describe('bumpEpoch / refreshAndPublish (§4.5)', () => {
  it('bumpEpoch returns the new epoch and publishes an invalidation event', async () => {
    vi.mocked(docMetaRepo.bumpEpoch).mockResolvedValue(3)
    const epoch = await bumpEpoch('d_1', 'octo:s:f:d_1', 'u_target')
    expect(epoch).toBe(3)
    expect(redisPublish).toHaveBeenCalledTimes(1)
  })

  it('refreshAndPublish warms the cache so currentEpoch reads it without DB', async () => {
    await refreshAndPublish('octo:s:f:d_warm', 12)
    const epoch = await currentEpoch('octo:s:f:d_warm')
    expect(epoch).toBe(12)
    expect(docMetaRepo.getEpochByDocumentName).not.toHaveBeenCalled()
  })
})
