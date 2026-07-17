import { describe, it, expect, vi, beforeEach } from 'vitest'

// XIN-1237 — recent-view space 口径统一 (write/read space must agree).
//
// The read side (GET /docs/recent) filters doc_view_history rows by the VIEWER's
// CURRENT space (the X-Space-Id header). For a doc opened from a chat share link
// the standalone page never calls POST /docs/{id}/view; the only ingest is the
// collab-token fallback in issueCollabToken. If that fallback records the row
// under the DOCUMENT's home space (meta.space_id) instead of the viewer's current
// space, the read-by-current-space never returns it — exactly the bug from
// XIN-1234.
//
// Contract asserted here: when the collab-token request carries the viewer's
// current space, the fallback ingest MUST record under THAT space (so it matches
// the read filter). When it does not (legacy client), it falls back to the
// document's home space — no regression for same-space opens.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { getByDocId: vi.fn(), getByDocumentName: vi.fn() },
}))
vi.mock('../src/db/repos/docMemberRepo.js', () => ({
  docMemberRepo: { getRole: vi.fn() },
}))
vi.mock('../src/db/repos/docViewHistoryRepo.js', () => ({
  docViewHistoryRepo: { upsertViewWithPrune: vi.fn() },
}))

import { issueCollabToken } from '../src/auth/issueCollabToken.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { docMemberRepo } from '../src/db/repos/docMemberRepo.js'
import { docViewHistoryRepo } from '../src/db/repos/docViewHistoryRepo.js'
import { setOctoIdentity } from '../src/auth/octoIdentity.js'

// The document lives in its OWN home space; the viewer is currently working in a
// DIFFERENT space (e.g. opened the doc from a chat share link).
const DOC_SPACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const VIEWER_SPACE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FOLDER = 'f_default'
const DOC_ID = 'd_share123'
const DOC_KEY = `octo:${DOC_SPACE}:${FOLDER}:${DOC_ID}`

const docMeta = (ownerId: string) =>
  ({
    doc_id: DOC_ID,
    document_name: DOC_KEY,
    owner_id: ownerId,
    space_id: DOC_SPACE,
    folder_id: FOLDER,
    doc_type: 'doc',
    status: 1,
    permission_epoch: 2,
  }) as never

function asUser(uid: string | null) {
  setOctoIdentity({
    verifyToken: async (token: string) => (token && uid ? { uid } : null),
    getUser: async () => null,
    getUsers: async () => [],
  })
}

beforeEach(() => {
  vi.mocked(docMetaRepo.getByDocId).mockReset()
  vi.mocked(docMetaRepo.getByDocumentName).mockReset()
  vi.mocked(docMemberRepo.getRole).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockReset()
  vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mockResolvedValue(new Date())
})

describe('issueCollabToken — recent-view space 口径统一 (XIN-1237)', () => {
  it('records the view under the VIEWER current space, not the document home space', async () => {
    asUser('u_viewer')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader') // read-only share open still counts

    // Viewer opens the shared doc while in VIEWER_SPACE (passed by the caller
    // from the collab-token request's X-Space-Id header).
    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, VIEWER_SPACE)
    expect(out.ok).toBe(true)
    expect(docViewHistoryRepo.upsertViewWithPrune).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.uid).toBe('u_viewer')
    expect(arg.docId).toBe(DOC_ID)
    // The write space MUST equal the viewer's current space so the read
    // (filtered by X-Space-Id) can return this row. This is the bug fix.
    expect(arg.spaceId).toBe(VIEWER_SPACE)
    expect(arg.spaceId).not.toBe(DOC_SPACE)
  })

  it('falls back to the document home space when no viewer space is supplied (legacy client, no regression)', async () => {
    asUser('u_viewer')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY)
    expect(out.ok).toBe(true)
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.spaceId).toBe(DOC_SPACE)
  })

  it('ignores an empty viewer space and falls back to the document home space', async () => {
    asUser('u_viewer')
    vi.mocked(docMetaRepo.getByDocumentName).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMetaRepo.getByDocId).mockResolvedValue(docMeta('owner_z'))
    vi.mocked(docMemberRepo.getRole).mockResolvedValue('reader')

    const out = await issueCollabToken('octo_session_viewer', DOC_KEY, '   ')
    expect(out.ok).toBe(true)
    const arg = vi.mocked(docViewHistoryRepo.upsertViewWithPrune).mock.calls[0]![0]
    expect(arg.spaceId).toBe(DOC_SPACE)
  })
})
