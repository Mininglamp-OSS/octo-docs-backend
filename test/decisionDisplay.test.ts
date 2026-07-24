import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the identity module so buildDecisionDisplay's operator lookup is
// deterministic and importing this module does not pull in config/env.
const getUser = vi.fn()
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ getUser }),
}))

const { formatDecidedAt, buildDecisionDisplay } = await import('../src/api/services/decisionDisplay.js')

describe('formatDecidedAt', () => {
  it('formats a unix-seconds timestamp to YYYY-MM-DD HH:mm', () => {
    // 2026-07-24 15:35:00 local
    const secs = Math.floor(new Date(2026, 6, 24, 15, 35, 0).getTime() / 1000)
    expect(formatDecidedAt(secs)).toBe('2026-07-24 15:35')
  })

  it('normalizes a millisecond timestamp the same way', () => {
    const ms = new Date(2026, 6, 24, 15, 35, 0).getTime()
    expect(formatDecidedAt(ms)).toBe('2026-07-24 15:35')
  })

  it('returns empty for missing / non-positive / non-finite input', () => {
    expect(formatDecidedAt(0)).toBe('')
    expect(formatDecidedAt(-1)).toBe('')
    expect(formatDecidedAt(Number.NaN)).toBe('')
  })
})

describe('buildDecisionDisplay', () => {
  beforeEach(() => getUser.mockReset())

  it('includes operator_name (resolved) and decided_at when available', async () => {
    getUser.mockResolvedValueOnce({ uid: 'op-1', name: '张三' })
    const secs = Math.floor(new Date(2026, 6, 24, 15, 35, 0).getTime() / 1000)
    const display = await buildDecisionDisplay('季度目标', 'op-1', secs)
    expect(display).toEqual({ title: '季度目标', operator_name: '张三', decided_at: '2026-07-24 15:35' })
  })

  it('omits operator_name when the lookup misses (octo-server keeps its UID fallback)', async () => {
    getUser.mockResolvedValueOnce(null)
    const display = await buildDecisionDisplay('季度目标', 'op-1', 0)
    expect(display).toEqual({ title: '季度目标' })
    expect(display.operator_name).toBeUndefined()
  })

  it('never throws when the lookup rejects; still returns title + decided_at', async () => {
    getUser.mockRejectedValueOnce(new Error('identity unreachable'))
    const secs = Math.floor(new Date(2026, 6, 24, 15, 35, 0).getTime() / 1000)
    const display = await buildDecisionDisplay('', 'op-1', secs)
    expect(display).toEqual({ title: '文档访问申请', decided_at: '2026-07-24 15:35' })
  })
})
