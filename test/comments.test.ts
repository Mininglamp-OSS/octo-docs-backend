import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: mock the auth guard and the MySQL pool. The real
// docCommentRepo runs against the mocked `query` / `transaction`, so the repo
// round-trip and the route handlers are exercised without live infra.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import {
  listCommentsHandler,
  createCommentHandler,
  patchCommentHandler,
  deleteCommentHandler,
} from '../src/api/routes/comments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { query, transaction } from '../src/db/pool.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  const res = {
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
  return res
}

function req(opts: {
  uid?: string
  params?: Record<string, string>
  body?: unknown
  query?: Record<string, string>
}) {
  return {
    uid: opts.uid ?? 'u_reader',
    params: opts.params ?? {},
    body: opts.body,
    query: opts.query ?? {},
  } as never
}

const readerGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1' }, role: 'reader' } as never
const writerGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1' }, role: 'writer' } as never
const adminGuard = { meta: { doc_id: 'd_1', document_name: 'octo:s:f:d_1' }, role: 'admin' } as never

/** Make requireDocRole emulate a 403 the way the real guard does (write + null). */
function forbidGuard() {
  vi.mocked(requireDocRole).mockImplementation((async (res: MockRes) => {
    res.status(403).json({ error: 'forbidden' })
    return null
  }) as never)
}

/** Mock create()'s transaction so it returns a fixed insert id; capture INSERT args. */
let txQuery: ReturnType<typeof vi.fn>
function mockInsertId(id: number) {
  txQuery = vi.fn(async (sql: string) => (String(sql).includes('LAST_INSERT_ID') ? [{ id }] : []))
  vi.mocked(transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({ query: txQuery })) as never)
}

/** A stored thread root row (snake_case, as mysql2 returns it). */
function rootRow(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    doc_id: 'd_1',
    document_name: 'octo:s:f:d_1',
    parent_id: null,
    author_uid: 'u_author',
    body: 'hello',
    anchor_start: Buffer.from('start'),
    anchor_end: Buffer.from('end'),
    anchor_text: 'snap',
    resolved: 0,
    resolved_by: null,
    resolved_at: null,
    deleted: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
  vi.mocked(transaction).mockReset()
})

describe('POST create (reader can comment)', () => {
  it('creates a root comment as a reader and returns the new id', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(123)
    const res = mockRes()
    await createCommentHandler(
      req({
        uid: 'u_reader',
        params: { docId: 'd_1' },
        body: { body: 'a note', anchorStart: Buffer.from('s').toString('base64'), anchorEnd: Buffer.from('e').toString('base64'), anchorText: 'sel' },
      }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect((res.body as { id: number }).id).toBe(123)
    // reader role is sufficient (product decision read => can comment).
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
  })

  it('rejects a root comment with no anchors (root/reply anchor invariant)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    mockInsertId(1)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'no anchor here' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(transaction)).not.toHaveBeenCalled()
  })

  it('rejects an empty body with 400', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: '   ', anchorStart: 'AA==', anchorEnd: 'AA==' } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
  })

  it('creates a reply and stores NULL anchors (reply anchor invariant)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    // getById(parent) -> an existing root in this doc.
    vi.mocked(query).mockResolvedValueOnce([rootRow({ id: 10 })] as never)
    mockInsertId(200)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'a reply', parentId: 10 } }),
      res as never,
    )
    expect(res.statusCode).toBe(201)
    expect((res.body as { id: number }).id).toBe(200)
    // INSERT args: parent_id = 10, both anchors NULL.
    const insert = txQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_comment'))!
    const args = insert[1] as unknown[]
    expect(args[2]).toBe(10) // parent_id
    expect(args[5]).toBeNull() // anchor_start
    expect(args[6]).toBeNull() // anchor_end
  })

  it('rejects a reply to a non-root (single-level nesting only)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10 })] as never)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'nested', parentId: 11 } }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
  })

  it('404s when the reply parent belongs to a different doc (no leak)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    vi.mocked(query).mockResolvedValueOnce([rootRow({ id: 12, doc_id: 'd_OTHER' })] as never)
    const res = mockRes()
    await createCommentHandler(
      req({ params: { docId: 'd_1' }, body: { body: 'x', parentId: 12 } }),
      res as never,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH resolve / body edit', () => {
  it('requires writer to resolve a thread', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow()] as never)
    forbidGuard()
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_reader', params: { docId: 'd_1', id: '10' }, body: { resolved: true } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('writer')
  })

  it('resolves a thread for a writer and stamps resolved_by', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow()] as never)
    vi.mocked(requireDocRole).mockResolvedValue(writerGuard)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_writer', params: { docId: 'd_1', id: '10' }, body: { resolved: true } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const update = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('resolved = 1'))
    expect(update).toBeTruthy()
  })

  it('requires the author to edit the body', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_other', params: { docId: 'd_1', id: '10' }, body: { body: 'hijack' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
  })

  it('lets the author edit the body', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'edited' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const update = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('SET body = ?'))
    expect(update).toBeTruthy()
  })

  it('404s a cross-doc comment id (no leak)', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow({ doc_id: 'd_OTHER' })] as never)
    const res = mockRes()
    await patchCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, body: { body: 'edit' } }),
      res as never,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE soft / hard', () => {
  it('lets the author soft-delete their own comment', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const update = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('SET deleted = 1'))
    expect(update).toBeTruthy()
  })

  it('rejects a soft delete by a non-author', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_other', params: { docId: 'd_1', id: '10' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
  })

  it('requires admin for a hard delete', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow({ author_uid: 'u_author' })] as never)
    forbidGuard()
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_author', params: { docId: 'd_1', id: '10' }, query: { hard: '1' } }),
      res as never,
    )
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('admin')
  })

  it('hard-deletes for an admin', async () => {
    vi.mocked(query).mockResolvedValueOnce([rootRow()] as never)
    vi.mocked(requireDocRole).mockResolvedValue(adminGuard)
    const res = mockRes()
    await deleteCommentHandler(
      req({ uid: 'u_admin', params: { docId: 'd_1', id: '10' }, query: { hard: '1' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const del = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('DELETE FROM doc_comment'))
    expect(del).toBeTruthy()
  })
})

describe('GET list', () => {
  it('returns roots with their replies and a nextCursor', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(readerGuard)
    // listRoots -> one root; then listReplies -> one reply.
    vi.mocked(query)
      .mockResolvedValueOnce([rootRow({ id: 10 })] as never)
      .mockResolvedValueOnce([rootRow({ id: 11, parent_id: 10, anchor_start: null, anchor_end: null })] as never)
    const res = mockRes()
    await listCommentsHandler(
      req({ params: { docId: 'd_1' }, query: { limit: '1' } }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { items: Array<{ id: number; anchorStart: string | null; replies: unknown[] }>; nextCursor: number | null }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.id).toBe(10)
    expect(body.items[0]!.anchorStart).toBe(Buffer.from('start').toString('base64'))
    expect(body.items[0]!.replies).toHaveLength(1)
    // limit was filled (1 root) => nextCursor is the last root id.
    expect(body.nextCursor).toBe(10)
  })
})

describe('docCommentRepo (§3.4)', () => {
  it('create inserts the mapped columns and returns the DB-assigned id', async () => {
    mockInsertId(777)
    const id = await docCommentRepo.create({
      docId: 'd_1',
      documentName: 'octo:s:f:d_1',
      parentId: null,
      authorUid: 'u_1',
      body: 'hi',
      anchorStart: Buffer.from('s'),
      anchorEnd: Buffer.from('e'),
      anchorText: 'sel',
    })
    expect(id).toBe(777)
    const insert = txQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_comment'))!
    expect((insert[1] as unknown[])[0]).toBe('d_1')
  })

  it('getById maps snake_case columns to camelCase', async () => {
    vi.mocked(query).mockResolvedValue([rootRow({ id: 10, resolved: 1, resolved_by: 'u_w' })] as never)
    const got = await docCommentRepo.getById(10)
    expect(got).toMatchObject({ id: 10, docId: 'd_1', parentId: null, resolved: true, resolvedBy: 'u_w', deleted: false })
  })

  it('listRoots filters out resolved threads unless includeResolved', async () => {
    vi.mocked(query).mockResolvedValue([] as never)
    await docCommentRepo.listRoots('d_1', { includeResolved: false, cursor: null, limit: 50 })
    const sql = String(vi.mocked(query).mock.calls[0]![0])
    expect(sql).toContain('parent_id IS NULL')
    expect(sql).toContain('resolved = 0')
  })
})
