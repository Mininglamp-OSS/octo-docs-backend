import { describe, it, expect, vi, beforeEach } from 'vitest'

// buildDecisionDisplay resolves the operator name through getOctoIdentity().getUser;
// mock it so the display assembly is exercised without a live octo-server. The
// remaining mocks mirror cardActionDecide.test.ts so importing the route module
// has no DB/config side effects.
const getUser = vi.fn()
vi.mock('../src/auth/octoIdentity.js', () => ({ getOctoIdentity: () => ({ getUser }) }))
vi.mock('../src/config/env.js', () => ({ config: { notify: { cardActionSecret: 'x' } } }))
vi.mock('../src/db/repos/docCardActionReceiptRepo.js', () => ({
  docCardActionReceiptRepo: { claim: vi.fn(), getResponse: vi.fn(), finalize: vi.fn() },
}))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({ docMetaRepo: { getByDocId: vi.fn() } }))
vi.mock('../src/db/repos/docAccessRequestRepo.js', () => ({
  REQUEST_STATUS_PENDING: 1,
  REQUEST_STATUS_APPROVED: 2,
  REQUEST_STATUS_DENIED: 3,
  REQUEST_STATUS_CANCELLED: 4,
  docAccessRequestRepo: { getByRequestId: vi.fn(), decide: vi.fn() },
}))
vi.mock('../src/permission/resolveRole.js', () => ({ resolveRole: vi.fn() }))
vi.mock('../src/api/services/grantForward.js', () => ({ grantForwardAccess: vi.fn() }))

import { formatDecidedAt, buildDecisionDisplay } from '../src/api/routes/cardActionDecide.js'

describe('formatDecidedAt', () => {
  it('formats a unix-seconds timestamp as YYYY-MM-DD HH:mm', () => {
    const seconds = 1784000000
    const out = formatDecidedAt(seconds)
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(Number(out.slice(0, 4))).toBe(new Date(seconds * 1000).getFullYear())
  })

  it('normalizes milliseconds to the same result as seconds', () => {
    const ms = 1784000000000
    expect(formatDecidedAt(ms)).toBe(formatDecidedAt(ms / 1000))
  })

  it('returns empty for missing / non-positive / non-finite input', () => {
    expect(formatDecidedAt(0)).toBe('')
    expect(formatDecidedAt(-5)).toBe('')
    expect(formatDecidedAt(Number.NaN)).toBe('')
  })
})

describe('buildDecisionDisplay', () => {
  beforeEach(() => getUser.mockReset())

  it('includes the resolved operator_name and formatted decided_at', async () => {
    getUser.mockResolvedValueOnce({ uid: 'u1', name: '张三' })
    const display = await buildDecisionDisplay('无标题文档', 'u1', 1784000000)
    expect(display.title).toBe('无标题文档')
    expect(display.operator_name).toBe('张三')
    expect(display.decided_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('omits operator_name when getUser misses, so octo-server keeps its uid fallback', async () => {
    getUser.mockResolvedValueOnce(null)
    const display = await buildDecisionDisplay('无标题文档', 'u1', 1784000000)
    expect(display.operator_name).toBeUndefined()
    expect(display.title).toBe('无标题文档')
  })

  it('never throws when getUser rejects; degrades to title only (empty acted_at → no decided_at)', async () => {
    getUser.mockRejectedValueOnce(new Error('network'))
    const display = await buildDecisionDisplay('', 'u1', 0)
    expect(display.title).toBe('文档访问申请')
    expect(display.operator_name).toBeUndefined()
    expect(display.decided_at).toBeUndefined()
  })
})
