import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the repos so this is an offline unit test (no DB). Identity is injected
// through the setOctoIdentity test seam.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))

import { issueCollabToken } from '../src/auth/issueCollabToken.js'
import { verifyCollabToken } from '../src/auth/collabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

const SPACE = '6fd5d5cf10b14d6ebe814b63a856766d'
const FOLDER = 'f_default'
const BOARD_ID = 'd_6a115afc1dea9ec20287117c'
const BOARD_KEY = `octo:${SPACE}:${FOLDER}:wb:${BOARD_ID}`
const DOC_ID = 'd_abc123'
const DOC_KEY = `octo:${SPACE}:${FOLDER}:${DOC_ID}`

const boardMeta = (ownerId: string) =>
  ({
    doc_id: BOARD_ID,
    // A board's document_name IS its 5-segment `:wb:` key (§8.1) — the row is
    // resolved by this key, same as a document.
    document_name: BOARD_KEY,
    owner_id: ownerId,
    space_id: SPACE,
    folder_id: FOLDER,
    doc_type: 'board',
    status: 1,
    permission_epoch: 4,
  }) as never

const docMeta = (ownerId: string) =>
  ({
    doc_id: DOC_ID,
    document_name: DOC_KEY,
    owner_id: ownerId,
    space_id: SPACE,
    folder_id: FOLDER,
    doc_type: 'doc',
    status: 1,
    permission_epoch: 2,
  }) as never

/** Inject a stub identity that maps any non-empty token to a fixed uid. */
function asUser(uid: string | null) {
  setOctoIdentity({
    verifyToken: async (token: string) => (token && uid ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
  })
}

describe('issueCollabToken (§4.4) — whiteboard support', () => {
  beforeEach(() => {
    vi.mocked(docMetaRepo.getByDocId).mockReset()
    vi.mocked(docMetaRepo.getByDocumentName).mockReset()
    vi.mocked(docMemberRepo.getRole).mockReset()
  })

  it('owner of a whiteboard gets a 200 admin token (resolved by document_name)', async () => {
    asUser('wbtest_a')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(boardMeta('wbtest_a'))
    // resolveRole(uid, doc_id) re-reads the row by doc_id for the owner check.
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(boardMeta('wbtest_a'))

    const out = await issueCollabToken('octo_session_a', BOARD_KEY)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.role).toBe('admin')
    // Board is resolved by its `:wb:` document_name — the single shared path.
    expect(docMetaRepo.getByDocumentName).toHaveBeenCalledWith(BOARD_KEY)
    // owner is implicit admin — no member row consulted.
    expect(docMemberRepo.getRole).not.toHaveBeenCalled()

    const claims = verifyCollabToken(out.result.token)
    expect(claims).toEqual({
      uid: 'wbtest_a',
      documentName: BOARD_KEY, // token carries the `:wb:` connection key
      role: 'admin',
      permission_epoch: 4,
    })
  })

  it('writer member of a whiteboard gets a 200 writer token', async () => {
    asUser('wbtest_b')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(boardMeta('wbtest_a'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(boardMeta('wbtest_a'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('writer')

    const out = await issueCollabToken('octo_session_b', BOARD_KEY)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.role).toBe('writer')
    const claims = verifyCollabToken(out.result.token)
    expect(claims.role).toBe('writer')
    expect(claims.documentName).toBe(BOARD_KEY)
  })

  it('non-member on a whiteboard is 403 (no token)', async () => {
    asUser('stranger')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(boardMeta('wbtest_a'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(boardMeta('wbtest_a'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue(undefined)

    const out = await issueCollabToken('octo_session_x', BOARD_KEY)
    expect(out).toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('missing / deleted board is 404', async () => {
    asUser('wbtest_a')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(null)
    expect(await issueCollabToken('t', BOARD_KEY)).toEqual({ ok: false, status: 404, error: 'not_found' })

    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue({ ...boardMeta('wbtest_a'), status: 0 } as never)
    expect(await issueCollabToken('t', BOARD_KEY)).toEqual({ ok: false, status: 404, error: 'not_found' })
  })

  it('a `:wb:` key that resolves to a non-board row is 404 (namespace addresses boards only)', async () => {
    asUser('wbtest_a')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue({ ...boardMeta('wbtest_a'), doc_type: 'doc' } as never)
    expect(await issueCollabToken('t', BOARD_KEY)).toEqual({ ok: false, status: 404, error: 'not_found' })
  })

  it('a `:wb:` key whose space/folder disagree with the resolved row is not_found (§8.1 consistency)', async () => {
    asUser('wbtest_a')
    // The row's stored space/folder differ from the requested key's segments;
    // the shared resolver rejects the mismatch, and a well-formed key that
    // resolves to no valid row is 404.
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(boardMeta('wbtest_a'))
    const wrongFolder = `octo:${SPACE}:f_other:wb:${BOARD_ID}`
    expect(await issueCollabToken('t', wrongFolder)).toEqual({ ok: false, status: 404, error: 'not_found' })

    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(boardMeta('wbtest_a'))
    const wrongSpace = `octo:s_other:${FOLDER}:wb:${BOARD_ID}`
    expect(await issueCollabToken('t', wrongSpace)).toEqual({ ok: false, status: 404, error: 'not_found' })
  })

  it('missing/invalid octo token is 401 before any repo lookup', async () => {
    asUser(null)
    expect(await issueCollabToken('', BOARD_KEY)).toEqual({ ok: false, status: 401, error: 'login_required' })
    expect(docMetaRepo.getByDocumentName).not.toHaveBeenCalled()
  })

  it('malformed documentName is 403', async () => {
    asUser('wbtest_a')
    expect(await issueCollabToken('t', 'not-a-key')).toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('does not break the document path: member gets a 200 token resolved by document_name', async () => {
    asUser('u_doc')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    // resolveRole(uid, doc_id) re-reads the row by doc_id.
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_doc', DOC_KEY)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.role).toBe('reader')
    expect(docMetaRepo.getByDocumentName).toHaveBeenCalledWith(DOC_KEY)
    const claims = verifyCollabToken(out.result.token)
    expect(claims.documentName).toBe(DOC_KEY)
    expect(claims.permission_epoch).toBe(2)
  })
})
