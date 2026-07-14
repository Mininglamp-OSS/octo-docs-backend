import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the collab-token issuance seam (#64, design §5.1/§5.3).
// Repos are mocked; identity (incl. isSpaceMember) is injected via setOctoIdentity.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))

import { issueCollabToken } from '../src/auth/issueCollabToken.js'
import { verifyCollabToken, signCollabToken } from '../src/auth/collabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const SPACE = 'sp_1'
const FOLDER = 'f_default'
const DOC_ID = 'd_share'
const DOC_KEY = `octo:${SPACE}:${FOLDER}:${DOC_ID}`

const docMeta = (over: Record<string, unknown> = {}) =>
  ({
    doc_id: DOC_ID,
    document_name: DOC_KEY,
    owner_id: 'u_owner',
    space_id: SPACE,
    folder_id: FOLDER,
    doc_type: 'doc',
    status: 1,
    permission_epoch: 3,
    share_scope: 0,
    share_role: 1,
    ...over,
  }) as never

let memberCalls: number
/** uid -> fixed identity, with an isSpaceMember that returns the configured value. */
function asUser(uid: string, member: boolean) {
  memberCalls = 0
  setOctoIdentity({
    verifyToken: async (t: string) => (t ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
    isSpaceMember: async () => {
      memberCalls += 1
      return member
    },
  } as never)
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
})

describe('issueCollabToken — space-scoped share (#64)', () => {
  it('restricted doc: non-member gets 403 and isSpaceMember is NEVER called (zero new IO)', async () => {
    asUser('u_x', true)
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta())
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta())
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
    expect(memberCalls).toBe(0)
  })

  it('anyone_in_space/edit: a space member with no doc_member gets a writer token + space_member claim', async () => {
    asUser('u_m', true)
    const m = docMeta({ share_scope: 1, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.role).toBe('writer')
      const claims = verifyCollabToken(out.result.token)
      expect(claims.role).toBe('writer')
      expect(claims.space_member).toBe(true)
    }
    expect(memberCalls).toBe(1)
  })

  it('anyone_in_space/read: member gets reader', async () => {
    asUser('u_m', true)
    const m = docMeta({ share_scope: 1, share_role: 1 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY)
    expect(out.ok && out.result.role).toBe('reader')
  })

  it('A1/A3: non-member (isSpaceMember false — incl. the fail-closed lookup path) => 403, no token', async () => {
    // isSpaceMember is fail-closed at the source (returns false on any lookup
    // error — see isSpaceMember.test.ts), so both a genuine non-member (A1) and
    // an unreachable octo-server (A3) reach issuance as `false`.
    asUser('u_x', false)
    const m = docMeta({ share_scope: 1, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(null as never)
    const out = await issueCollabToken('tok', DOC_KEY)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })

  it('owner on an anyone_in_space doc stays admin and carries no space_member claim if not a member', async () => {
    asUser('u_owner', false)
    const m = docMeta({ share_scope: 1, share_role: 2 })
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(m)
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(m)
    const out = await issueCollabToken('tok', DOC_KEY)
    expect(out.ok && out.result.role).toBe('admin')
    if (out.ok) expect(verifyCollabToken(out.result.token).space_member).toBeUndefined()
  })

  it('O1: a token minted without the space_member claim verifies and reports false', () => {
    // A pre-#64 token carried no space_member — verify must not reject it, and
    // the claim reads as absent (=> false at the use site, fail-closed).
    const legacy = signCollabToken({
      uid: 'u_1',
      documentName: DOC_KEY,
      role: 'reader',
      permission_epoch: 3,
    })
    const claims = verifyCollabToken(legacy.token)
    expect(claims.role).toBe('reader')
    expect(claims.space_member).toBeUndefined()
  })
})
