import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the live-socket write-recheck seam (#64, design §5.3
// case 2). recheckCurrentRole is exercised for real against a mocked doc_meta row
// (read FRESH each call, so a scope narrowing takes effect) + a mocked doc_member
// role, with the requester's space membership supplied as the token-carried claim.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))

import { recheckCurrentRole } from '../src/permission/resolveRole.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import type { ResolvedRole } from '../src/permission/role.js'

const SPACE = 's1'
const FOLDER = 'f_default'
const DOC_ID = 'd_1'
const KEY = `octo:${SPACE}:${FOLDER}:${DOC_ID}`

const meta = (over: Record<string, unknown> = {}) => ({
  doc_id: DOC_ID,
  document_name: KEY,
  owner_id: 'u_owner',
  space_id: SPACE,
  folder_id: FOLDER,
  doc_type: 'doc',
  status: 1,
  permission_epoch: 5,
  share_scope: 0,
  share_role: 1,
  ...over,
})

function setup(metaOver: Record<string, unknown>, directRole: ResolvedRole) {
  vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(meta(metaOver) as never)
  vi.mocked(docMemberRepo.getRole).mockResolvedValue((directRole === 'none' ? null : directRole) as never)
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
})

describe('recheckCurrentRole — share-aware live recheck (#64)', () => {
  it('anyone_in_space/edit + space_member claim => writer (share-derived, no doc_member)', async () => {
    setup({ share_scope: 1, share_role: 2 }, 'none')
    expect(await recheckCurrentRole(KEY, 'u_m', true)).toBe('writer')
  })

  it('N1 narrow edit->read: same connected member now rechecks to reader (< writer => write drops)', async () => {
    setup({ share_scope: 1, share_role: 1 }, 'none')
    expect(await recheckCurrentRole(KEY, 'u_m', true)).toBe('reader')
  })

  it('N2 narrow ->restricted: member with no doc_member drops to none (4403 on refresh)', async () => {
    setup({ share_scope: 0, share_role: 1 }, 'none')
    expect(await recheckCurrentRole(KEY, 'u_m', true)).toBe('none')
  })

  it('N4: an owner/doc_member writer is unaffected by a narrowing (base role wins)', async () => {
    setup({ share_scope: 0, share_role: 1 }, 'writer')
    expect(await recheckCurrentRole(KEY, 'u_w', true)).toBe('writer')
    setup({ share_scope: 0, share_role: 1 }, 'none') // owner has no doc_member row
    expect(await recheckCurrentRole(KEY, 'u_owner', false)).toBe('admin')
  })

  it('O1: old token (space_member absent => false) gets NO share-derived role on anyone_in_space', async () => {
    setup({ share_scope: 1, share_role: 2 }, 'none')
    // default param (no claim) => false => fail-closed, no share-derived writer.
    expect(await recheckCurrentRole(KEY, 'u_m')).toBe('none')
    // but a direct doc_member role is still preserved for the same old token.
    setup({ share_scope: 1, share_role: 2 }, 'reader')
    expect(await recheckCurrentRole(KEY, 'u_m')).toBe('reader')
  })

  it('N5 space-membership revocation: scope stays anyone_in_space/edit but the claim is now false => write cut to none', async () => {
    // Decision #3 (boss-locked): live-socket membership revocation is bounded by
    // the collab-token TTL (≤ COLLAB_TOKEN_TTL_SECONDS), not epoch-bounded. This
    // asserts the cut itself: a share-derived writer with no doc_member row, once
    // their space_member claim resolves false (removed from the space), drops to
    // `none` on the next recheck even though the doc is STILL anyone_in_space/edit.
    setup({ share_scope: 1, share_role: 2 }, 'none')
    expect(await recheckCurrentRole(KEY, 'u_removed', true)).toBe('writer') // still a member
    expect(await recheckCurrentRole(KEY, 'u_removed', false)).toBe('none') // removed => cut
  })

  it('N5 revocation preserves a direct doc_member role (share loss only removes the share-derived grant)', async () => {
    // A removed space member who is ALSO a doc_member keeps their direct role —
    // revocation only strips the share-derived portion, never the base grant.
    setup({ share_scope: 1, share_role: 2 }, 'reader')
    expect(await recheckCurrentRole(KEY, 'u_both', false)).toBe('reader')
  })

  it('deleted / missing doc => none', async () => {
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(null as never)
    expect(await recheckCurrentRole(KEY, 'u_m', true)).toBe('none')
  })
})
