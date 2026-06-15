import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the repos resolveRole depends on, so this is an offline unit test.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))

import { resolveRole } from '../src/permission/resolveRole.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'

const meta = (owner: string) => ({
  doc_id: 'd_1',
  document_name: 'octo:s:f:d_1',
  owner_id: owner,
  folder_id: 'f',
  status: 1,
}) as never

describe('resolveRole (§4.2)', () => {
  beforeEach(() => {
    vi.mocked(docMetaRepo.getByDocId).mockReset()
    vi.mocked(docMemberRepo.getRole).mockReset()
  })

  it('owner resolves to admin (implicit, no member row consulted)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta('u_owner'))
    const role = await resolveRole('u_owner', 'd_1')
    expect(role).toBe('admin')
    expect(docMemberRepo.getRole).not.toHaveBeenCalled()
  })

  it('non-owner with a member row resolves to that role', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta('u_owner'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('writer')
    const role = await resolveRole('u_member', 'd_1')
    expect(role).toBe('writer')
  })

  it('non-owner with no member row resolves to none', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(meta('u_owner'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(undefined)
    const role = await resolveRole('u_stranger', 'd_1')
    expect(role).toBe('none')
  })

  it('missing doc resolves to none', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null)
    const role = await resolveRole('u_any', 'd_missing')
    expect(role).toBe('none')
  })
})
