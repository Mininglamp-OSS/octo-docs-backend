import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { Node as PMNode } from 'prosemirror-model'
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror'
import { COLLAB_FIELD } from '../src/schema/index.js'

// The live write happens on the in-memory Hocuspocus document via
// openDirectConnection. Mock that server boundary with a fake backed by a REAL
// Y.Doc, so commitLiveEdit's in-transact guard + reconcile run for real (no
// running collab server), exactly the path §7 tests 7/9 exercise.
const h = vi.hoisted(() => ({ liveDoc: null as unknown as Y.Doc }))
vi.mock('../src/collab/server.js', () => ({
  getCollabServer: () => ({
    hocuspocus: {
      openDirectConnection: async () => ({
        transact: async (cb: (doc: Y.Doc) => void) => {
          h.liveDoc.transact(() => cb(h.liveDoc))
        },
        disconnect: async () => {},
      }),
    },
  }),
}))

import { readLiveForEdit, commitLiveEdit } from '../src/collab/liveDocWrite.js'
import { schema, BaseVersionStaleError, type DocEditOp } from '../src/collab/docBodyEdit.js'
import { computeFinalState } from '../src/collab/persistence.js'

function para(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function docNode(content: unknown[]): PMNode {
  return PMNode.fromJSON(schema, { type: 'doc', content } as Parameters<typeof PMNode.fromJSON>[1])
}

function liveFrom(content: unknown[]): Y.Doc {
  const doc = new Y.Doc()
  const frag = doc.get(COLLAB_FIELD, Y.XmlFragment)
  doc.transact(() => prosemirrorToYXmlFragment(docNode(content), frag))
  return doc
}

function topTexts(doc: Y.Doc): string[] {
  const json = yDocToProsemirrorJSON(doc, COLLAB_FIELD) as { content?: Array<{ content?: Array<{ text?: string }> }> }
  return (json.content ?? []).map((b) => (b.content ?? []).map((c) => c.text ?? '').join(''))
}

beforeEach(() => {
  h.liveDoc = liveFrom([para('A'), para('B')])
})

describe('readLiveForEdit', () => {
  it('returns the live PM doc, its base SV, and the raw pre-edit state', async () => {
    const { pmDoc, baseSV, preEditState } = await readLiveForEdit('doc:1')
    expect(pmDoc.type.name).toBe('doc')
    expect(baseSV).toEqual(Y.encodeStateVector(h.liveDoc))
    expect(preEditState).toEqual(Y.encodeStateAsUpdate(h.liveDoc))
  })
})

describe('commitLiveEdit — guarded write', () => {
  it('applies the edit and returns the NEW base version + byte length', async () => {
    const clientBaseVersion = Y.encodeStateVector(h.liveDoc)
    const preEditState = Y.encodeStateAsUpdate(h.liveDoc)
    const ops: DocEditOp[] = [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }]

    const { newSV, bytes } = await commitLiveEdit('doc:1', 'u_1', clientBaseVersion, ops, schema)

    expect(topTexts(h.liveDoc)).toEqual(['A', 'X', 'B'])
    expect(bytes).toBeGreaterThan(0)
    // The base version advanced (content changed => some clientId clock moved).
    expect(newSV).not.toEqual(clientBaseVersion)

    // §7.7: the write is a minimal, forward, union-safe delta — computeFinalState
    // takes the diffUpdate bypass (reconciled ⊇ pre-edit), never the union reback.
    const newState = Y.encodeStateAsUpdate(h.liveDoc)
    const { usedUnion } = computeFinalState(preEditState, newState)
    expect(usedUnion).toBe(false)
  })

  it('§7.9: a stale client base version throws BEFORE any mutation or broadcast', async () => {
    // The client token is from a DIFFERENT (empty) doc — simulates a human edit
    // landing between the bot's GET and this commit (or a misrouted non-owner node).
    const staleToken = Y.encodeStateVector(new Y.Doc())
    const before = topTexts(h.liveDoc)
    const ops: DocEditOp[] = [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }]

    await expect(commitLiveEdit('doc:1', 'u_1', staleToken, ops, schema)).rejects.toBeInstanceOf(
      BaseVersionStaleError,
    )
    // Guard is the first statement, so the live doc is untouched (fail-closed).
    expect(topTexts(h.liveDoc)).toEqual(before)
  })

  it('chained edits reusing the returned base version succeed without a re-read', async () => {
    const ops1: DocEditOp[] = [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }]
    const first = await commitLiveEdit('doc:1', 'u_1', Y.encodeStateVector(h.liveDoc), ops1, schema)
    expect(topTexts(h.liveDoc)).toEqual(['A', 'X', 'B'])

    // Reuse first.newSV directly (no intervening GET) for the next edit.
    const ops2: DocEditOp[] = [{ type: 'insert', at: { path: [2], position: 'after' }, content: [para('Y')] }]
    await commitLiveEdit('doc:1', 'u_1', first.newSV, ops2, schema)
    expect(topTexts(h.liveDoc)).toEqual(['A', 'X', 'B', 'Y'])
  })

  // ── defect ②: a delete-only edit must still advance the base version ──────────
  it('§②: a delete-only edit advances the base version (state vector moves)', async () => {
    const before = Y.encodeStateVector(h.liveDoc)
    const del: DocEditOp[] = [{ type: 'delete', range: { from: { path: [0] }, to: { path: [0] } } }]
    const { newSV } = await commitLiveEdit('doc:1', 'u_1', before, del, schema)
    expect(topTexts(h.liveDoc)).toEqual(['B']) // content really changed
    // Without the version bump a delete-only reconcile leaves the SV byte-identical.
    expect(newSV).not.toEqual(before)
  })

  it('§②: reusing the pre-delete base version after a delete-only edit is a stale write (412)', async () => {
    const preDelete = Y.encodeStateVector(h.liveDoc)
    await commitLiveEdit('doc:1', 'u_1', preDelete, [
      { type: 'delete', range: { from: { path: [0] }, to: { path: [0] } } },
    ], schema)

    // The client reuses its now-stale pre-delete token for a follow-up write.
    const insert: DocEditOp[] = [{ type: 'insert', at: { path: [0], position: 'after' }, content: [para('X')] }]
    await expect(commitLiveEdit('doc:1', 'u_1', preDelete, insert, schema)).rejects.toBeInstanceOf(
      BaseVersionStaleError,
    )
    // Rejected before mutation: still just ['B'] from the delete above.
    expect(topTexts(h.liveDoc)).toEqual(['B'])
  })

  it('§②: the edit-version counter stays out of the ProseMirror body', async () => {
    await commitLiveEdit('doc:1', 'u_1', Y.encodeStateVector(h.liveDoc), [
      { type: 'delete', range: { from: { path: [0] }, to: { path: [0] } } },
    ], schema)
    // GET content reads only COLLAB_FIELD — the bump lives in a separate Y field.
    const json = yDocToProsemirrorJSON(h.liveDoc, COLLAB_FIELD) as { type: string }
    expect(json.type).toBe('doc')
    expect(topTexts(h.liveDoc)).toEqual(['B'])
  })
})
