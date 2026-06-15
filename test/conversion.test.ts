import { describe, it, expect } from 'vitest'
import {
  prosemirrorJSONToYDocState,
  yDocStateToProsemirrorJSON,
  COLLAB_FIELD,
} from '../src/agent/conversion.js'

describe('Agent ProseMirror <-> Y.Doc conversion (§7.1, no-DOM)', () => {
  it('round-trips a simple document through Y.Doc binary and back', () => {
    const pm = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'a title' }] },
      ],
    }
    const state = prosemirrorJSONToYDocState(pm)
    expect(state).toBeInstanceOf(Uint8Array)
    expect(state.length).toBeGreaterThan(0)

    const back = yDocStateToProsemirrorJSON(state)
    expect(back).toEqual(pm)
  })

  it('exposes COLLAB_FIELD as the shared "default" field name (appendix B)', () => {
    expect(COLLAB_FIELD).toBe('default')
  })

  it('rejects JSON that does not match the schema', () => {
    expect(() => prosemirrorJSONToYDocState({ type: 'not_a_node' })).toThrow()
  })
})
