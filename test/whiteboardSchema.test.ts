import { describe, it, expect } from 'vitest'
import {
  normalizeElement,
  elementSupersedes,
  isValidIndex,
  deterministicNonce,
  buildWhiteboardName,
  parseWhiteboardName,
  WhiteboardNameError,
  WB_ELEMENT_TYPES,
} from '../src/whiteboard/schema/index.js'

describe('@octo/whiteboard-schema normalizeElement (XIN-16 §1/§4/§6)', () => {
  it('drops elements with missing/blank id or non-whitelisted type', () => {
    expect(normalizeElement({ type: 'rectangle', version: 1 })).toBeNull()
    expect(normalizeElement({ id: '', type: 'rectangle' })).toBeNull()
    expect(normalizeElement({ id: 'x', type: 'wormhole' })).toBeNull()
    expect(normalizeElement(null)).toBeNull()
    expect(normalizeElement(42)).toBeNull()
  })

  it('coerces version to a positive integer (default 1)', () => {
    expect(normalizeElement({ id: 'a', type: 'rectangle' })!.version).toBe(1)
    expect(normalizeElement({ id: 'a', type: 'rectangle', version: 0 })!.version).toBe(1)
    expect(normalizeElement({ id: 'a', type: 'rectangle', version: -3 })!.version).toBe(1)
    expect(normalizeElement({ id: 'a', type: 'rectangle', version: 2.5 })!.version).toBe(1)
    expect(normalizeElement({ id: 'a', type: 'rectangle', version: 7 })!.version).toBe(7)
  })

  it('fills a DETERMINISTIC versionNonce when missing/invalid (no randomness)', () => {
    const a = normalizeElement({ id: 'a', type: 'rectangle', version: 3 })!
    const b = normalizeElement({ id: 'a', type: 'rectangle', version: 3 })!
    expect(a.versionNonce).toBe(b.versionNonce)
    expect(a.versionNonce).toBe(deterministicNonce('a:3'))
    // a valid existing nonce is preserved untouched
    expect(normalizeElement({ id: 'a', type: 'rectangle', versionNonce: 99 })!.versionNonce).toBe(99)
  })

  it('clamps non-finite numerics and out-of-range opacity', () => {
    const n = normalizeElement({
      id: 'a',
      type: 'rectangle',
      x: NaN,
      width: -10,
      height: Infinity,
      opacity: 250,
    })!
    expect(n.x).toBe(0)
    expect(n.width).toBe(0)
    expect(n.height).toBe(0)
    expect(n.opacity).toBe(100)
  })

  it('strips an invalid fractional index to absent state', () => {
    expect('index' in normalizeElement({ id: 'a', type: 'rectangle', index: 'a!b' })!).toBe(false)
    expect(normalizeElement({ id: 'a', type: 'rectangle', index: 'a0' })!.index).toBe('a0')
  })

  it('preserves unknown fields verbatim (§6 passthrough)', () => {
    const n = normalizeElement({ id: 'a', type: 'rectangle', customXYZ: { k: 1 }, futureFlag: true })!
    expect(n.customXYZ).toEqual({ k: 1 })
    expect(n.futureFlag).toBe(true)
  })

  it('prunes dangling boundElements and frameId against the element-id set', () => {
    const ctx = { elementIds: new Set(['a', 'keep']) }
    const n = normalizeElement(
      {
        id: 'a',
        type: 'rectangle',
        boundElements: [{ id: 'keep', type: 'text' }, { id: 'gone', type: 'arrow' }],
        frameId: 'missing',
      },
      ctx,
    )!
    expect(n.boundElements).toEqual([{ id: 'keep', type: 'text' }])
    expect(n.frameId).toBeNull()
  })

  it('clears a dangling containerId and keeps a live one (M-5, same shape as frameId)', () => {
    // Orphaned bound-text: its container element was deleted, so containerId dangles -> null.
    const orphan = normalizeElement(
      { id: 't', type: 'text', containerId: 'gone-container' },
      { elementIds: new Set(['t']) },
    )!
    expect(orphan.containerId).toBeNull()

    // Container still present -> containerId preserved verbatim.
    const bound = normalizeElement(
      { id: 't', type: 'text', containerId: 'box' },
      { elementIds: new Set(['t', 'box']) },
    )!
    expect(bound.containerId).toBe('box')

    // No elementIds context (the survivor pass) -> containerId untouched (not pruned).
    const noCtx = normalizeElement({ id: 't', type: 'text', containerId: 'box' })!
    expect(noCtx.containerId).toBe('box')
  })

  it('drops image elements whose fileId is dangling (when fileIds ctx given)', () => {
    const present = { fileIds: new Set(['f1']) }
    expect(normalizeElement({ id: 'i', type: 'image', fileId: 'f1' }, present)).not.toBeNull()
    expect(normalizeElement({ id: 'i', type: 'image', fileId: 'gone' }, present)).toBeNull()
    expect(normalizeElement({ id: 'i', type: 'image' }, present)).toBeNull()
  })

  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    const once = normalizeElement({ id: 'a', type: 'rectangle', version: 'bad' as never, x: NaN })!
    const twice = normalizeElement(once)!
    expect(twice).toEqual(once)
  })

  it('never mutates its input', () => {
    const input = { id: 'a', type: 'rectangle', x: NaN }
    normalizeElement(input)
    expect(Number.isNaN(input.x)).toBe(true)
  })
})

describe('elementSupersedes CAS arbitration (§1.1)', () => {
  it('higher version wins', () => {
    expect(elementSupersedes({ version: 1, versionNonce: 5 }, { version: 2, versionNonce: 9 })).toBe(true)
    expect(elementSupersedes({ version: 3, versionNonce: 5 }, { version: 2, versionNonce: 1 })).toBe(false)
  })
  it('equal version -> smaller versionNonce wins', () => {
    expect(elementSupersedes({ version: 2, versionNonce: 9 }, { version: 2, versionNonce: 4 })).toBe(true)
    expect(elementSupersedes({ version: 2, versionNonce: 4 }, { version: 2, versionNonce: 9 })).toBe(false)
  })
  it('fully equal -> not superseding (no write)', () => {
    expect(elementSupersedes({ version: 2, versionNonce: 4 }, { version: 2, versionNonce: 4 })).toBe(false)
  })
  it('no current element -> incoming wins', () => {
    expect(elementSupersedes(undefined, { version: 1, versionNonce: 1 })).toBe(true)
  })
})

describe('isValidIndex', () => {
  it('accepts base62 keys, rejects empty / non-string / punctuation', () => {
    expect(isValidIndex('a0')).toBe(true)
    expect(isValidIndex('Zz9')).toBe(true)
    expect(isValidIndex('')).toBe(false)
    expect(isValidIndex('a:b')).toBe(false)
    expect(isValidIndex(5)).toBe(false)
  })
})

describe('whiteboard name build/parse (§3)', () => {
  it('builds and round-trips a whiteboard key', () => {
    const name = buildWhiteboardName('s_1', 'f_2', 'board_3')
    expect(name).toBe('octo:s_1:f_2:wb:board_3')
    expect(parseWhiteboardName(name)).toEqual({ space: 's_1', folder: 'f_2', board: 'board_3' })
  })
  it('rejects non-whiteboard / malformed keys', () => {
    expect(() => parseWhiteboardName('octo:s:f:doc')).toThrow(WhiteboardNameError)
    expect(() => parseWhiteboardName('octo:s:f:wb:')).toThrow(WhiteboardNameError)
    expect(() => buildWhiteboardName('s', 'f', 'bad id')).toThrow(WhiteboardNameError)
  })
})

describe('WB_ELEMENT_TYPES whitelist', () => {
  it('includes the v1 Excalidraw types', () => {
    for (const t of ['rectangle', 'ellipse', 'arrow', 'text', 'image', 'frame']) {
      expect(WB_ELEMENT_TYPES.has(t)).toBe(true)
    }
  })
})
