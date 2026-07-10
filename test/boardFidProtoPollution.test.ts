import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { validateBoardOps, BoardFileInvalidError } from '../src/whiteboard/boardEdit.js'
import { decodeBoardSnapshot } from '../src/collab/versionRestore.js'
import { getElementsMap, getFilesMap } from '../src/whiteboard/ydoc.js'

/**
 * Regression: reserved prototype keys used as the `files` map KEY (the fileId /
 * fid itself), not as a field inside an element or file ref. XIN-743 rejected a
 * reserved key that appeared as a FIELD of an element / file ref, but the fid —
 * the key under which a file ref is stored in the `files` map — was still
 * unguarded: `PATCH files:{"__proto__":{attachId}}` passed validateBoardOps, was
 * stored as a Y.Map key, and then corrupted the plain-object read-back in
 * decodeBoardSnapshot (`files[fid] = readEntry(v)` routed a `__proto__` fid
 * through the Object.prototype setter — reparenting the scene's `files` object,
 * dropping the entry, and leaking inherited props). The fix rejects a reserved
 * fid fail-closed on write (422 board_file_invalid) and builds the read-back
 * `files` container with a null prototype so any already-stored fid is isolated.
 */

const RESERVED = ['__proto__', 'constructor', 'prototype'] as const

/** A valid file ref, parsed from JSON so no accidental reserved own key. */
function fileRef(): Record<string, unknown> {
  return JSON.parse('{"attachId":"a1","mimeType":"image/png","status":"saved"}') as Record<
    string,
    unknown
  >
}

/**
 * A `files` map whose KEY is a reserved name, built via JSON.parse so the key is
 * a real OWN property (JSON uses define-semantics, not the `__proto__` setter) —
 * the exact shape a malicious PATCH body arrives as.
 */
function filesWithReservedFid(fid: string): Record<string, unknown> {
  return JSON.parse(`{"${fid}":{"attachId":"a1","mimeType":"image/png","status":"saved"}}`) as Record<
    string,
    unknown
  >
}

describe('validateBoardOps rejects a reserved files-map fid (XIN-750)', () => {
  for (const fid of RESERVED) {
    it(`throws BoardFileInvalidError for a files map keyed by "${fid}"`, () => {
      expect(() => validateBoardOps({ files: filesWithReservedFid(fid) })).toThrow(
        BoardFileInvalidError,
      )
    })
  }

  it('still accepts a clean fid (no false positive)', () => {
    const ops = validateBoardOps({ files: { f_1: fileRef() } })
    expect(ops.fileUpserts).toHaveLength(1)
    expect(ops.fileUpserts[0][0]).toBe('f_1')
  })

  it('rejecting a reserved fid never pollutes Object.prototype', () => {
    for (const fid of RESERVED) {
      try {
        validateBoardOps({ files: filesWithReservedFid(fid) })
      } catch {
        /* expected 422 */
      }
    }
    expect(({} as Record<string, unknown>).attachId).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('attachId')
  })
})

describe('decodeBoardSnapshot isolates an already-stored reserved fid (XIN-750)', () => {
  /** Build a live board doc that already carries a reserved fid as a files key. */
  function boardWithStoredFid(fid: string): Uint8Array {
    const doc = new Y.Doc()
    doc.transact(() => {
      const el = new Y.Map<unknown>()
      el.set('id', 'e1')
      el.set('type', 'rectangle')
      el.set('index', 'a0')
      getElementsMap(doc).set('e1', el)

      const f = new Y.Map<unknown>()
      f.set('attachId', 'a1')
      f.set('mimeType', 'image/png')
      f.set('status', 'saved')
      getFilesMap(doc).set(fid, f)
    })
    return Y.encodeStateAsUpdate(doc)
  }

  for (const fid of RESERVED) {
    it(`reads back a "${fid}" fid without reparenting the files container`, () => {
      const scene = decodeBoardSnapshot(boardWithStoredFid(fid))

      // The files container is not reparented and inherits nothing.
      expect(Object.getPrototypeOf(scene.files)).toBeNull()
      expect((scene.files as { attachId?: unknown }).attachId).toBeUndefined()

      // The stored entry round-trips as a real OWN key rather than being dropped.
      expect(Object.prototype.hasOwnProperty.call(scene.files, fid)).toBe(true)
      expect(scene.files[fid].attachId).toBe('a1')

      // The unrelated element still decodes normally.
      expect(scene.elements).toHaveLength(1)
      expect(scene.elements[0].id).toBe('e1')
    })
  }

  it('decodes a clean board with a normal fid unchanged', () => {
    const scene = decodeBoardSnapshot(boardWithStoredFid('f_ok'))
    expect(scene.files.f_ok.attachId).toBe('a1')
  })
})
