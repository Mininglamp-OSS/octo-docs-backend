import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit tests for the single-doc by-space gate (P2). requireDocRole now takes a
// spaceId and 404s a cross-space hit BEFORE the role check, so a doc that lives
// in another space is indistinguishable from one that does not exist (no 403,
// no existence/role leak). We mock the repo and resolveRole so the gate logic is
// exercised in isolation; roleAtLeast runs for real.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    getByDocId: vi.fn(),
  },
}))
vi.mock('../src/permission/resolveRole.js', () => ({
  resolveRole: vi.fn(),
}))

import { requireDocRole } from '../src/api/guard.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { resolveRole } from '../src/permission/resolveRole.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}

/** A live (status===1) doc_meta row in space 's1'. */
function metaRow(over: Record<string, unknown> = {}) {
  return {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    title: 'My Doc',
    owner_id: 'u_owner',
    space_id: 's1',
    folder_id: 'f_default',
    doc_type: 'doc',
    status: 1,
    permission_epoch: 7,
    created_at: new Date(0),
    updated_at: new Date(1000),
    created_by: 'u_owner',
    updated_by: 'u_owner',
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(resolveRole).mockReset()
})

describe('requireDocRole — by-space single-doc gate (P2)', () => {
  it('404s a cross-space doc and never consults the role (gate runs before 403)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_1', 'd_1', 's2', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    // The gate short-circuits before role resolution — no existence/role leak.
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('returns 404 (not 403) even when the caller would otherwise be admin in the doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('admin' as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_admin', 'd_1', 's2', 'admin')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('404s a cross-space archived doc (gate runs before the 409 archived branch)', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1', status: 2 }) as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_1', 'd_1', 's2', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('lets a same-space request through and resolves the role as before', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('writer' as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_1', 'd_1', 's1', 'reader')

    expect(res.statusCode).toBe(0)
    expect(guard).not.toBeNull()
    expect(guard!.role).toBe('writer')
    expect(vi.mocked(resolveRole)).toHaveBeenCalledWith('u_1', 'd_1')
  })

  it('preserves the existing 404 for a missing/deleted doc regardless of space', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(null as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_1', 'd_1', 's1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
    expect(vi.mocked(resolveRole)).not.toHaveBeenCalled()
  })

  it('preserves the existing 409 for a same-space archived doc', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1', status: 2 }) as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_1', 'd_1', 's1', 'reader')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'conflict' })
  })

  it('preserves the existing 403 for a same-space doc when the role is insufficient', async () => {
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(metaRow({ space_id: 's1' }) as never)
    vi.mocked(resolveRole).mockResolvedValue('reader' as never)
    const res = mockRes()

    const guard = await requireDocRole(res as never, 'u_1', 'd_1', 's1', 'admin')

    expect(guard).toBeNull()
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })
})
