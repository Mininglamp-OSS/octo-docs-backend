import { describe, it, expect, beforeEach, vi } from 'vitest'

// The queue reads limits from config at call time; pin small limits so the
// saturation path is reachable deterministically.
vi.mock('../src/config/env.js', () => ({
  config: { docxImport: { maxConcurrent: 1, maxQueue: 1 } },
}))

import {
  acquireDocxImportSlot,
  releaseDocxImportSlot,
  DocxImportBusyError,
} from '../src/import/docx/importQueue.js'

describe('docx import queue', () => {
  beforeEach(() => {
    // Drain any slots a prior test may have left held.
    for (let i = 0; i < 8; i++) releaseDocxImportSlot()
  })

  it('grants up to maxConcurrent slots immediately', async () => {
    await expect(acquireDocxImportSlot()).resolves.toBeUndefined()
    releaseDocxImportSlot()
  })

  it('queues one waiter, then rejects with 503-mapped DocxImportBusyError over the cap', async () => {
    await acquireDocxImportSlot() // active = 1 (at maxConcurrent)
    const queued = acquireDocxImportSlot() // waits (queue depth 1, at maxQueue)
    // The next acquire exceeds maxQueue → reject.
    await expect(acquireDocxImportSlot()).rejects.toBeInstanceOf(DocxImportBusyError)
    // Releasing the active slot hands it to the queued waiter, which resolves.
    releaseDocxImportSlot()
    await expect(queued).resolves.toBeUndefined()
    releaseDocxImportSlot()
  })
})
