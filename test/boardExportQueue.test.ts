import { describe, it, expect } from 'vitest'
import { config } from '../src/config/env.js'
import {
  acquirePngSlot,
  releasePngSlot,
  BoardExportBusyError,
} from '../src/whiteboard/boardExportQueue.js'

// The PNG raster path is synchronous, CPU/memory-heavy Skia work, so the route
// gates it behind a bounded semaphore: at most maxConcurrent run, up to maxQueue
// wait, and anything beyond that sheds load with 503 (BoardExportBusyError). This
// pins that capacity math and the fairness of release → next-waiter handoff.
describe('boardExportQueue — PNG raster concurrency gate', () => {
  it('admits up to maxConcurrent immediately, queues maxQueue, then rejects', async () => {
    const { maxConcurrentPngExports: cap, maxQueuedPngExports: queue } = config.boardExport
    const held: Array<Promise<void>> = []

    // Fill the active slots — each resolves right away.
    for (let i = 0; i < cap; i++) held.push(acquirePngSlot())
    await Promise.all(held)

    // The next `queue` acquisitions have no free slot, so they park (pending).
    let queuedResolved = 0
    const queued: Array<Promise<void>> = []
    for (let i = 0; i < queue; i++) {
      queued.push(acquirePngSlot().then(() => void queuedResolved++))
    }
    await Promise.resolve()
    expect(queuedResolved).toBe(0) // all still waiting for a slot

    // One more beyond active + queued must be rejected outright.
    await expect(acquirePngSlot()).rejects.toBeInstanceOf(BoardExportBusyError)

    // Releasing an active slot hands it to the oldest waiter (FIFO), unblocking one.
    releasePngSlot()
    await Promise.resolve()
    await Promise.resolve()
    expect(queuedResolved).toBe(1)

    // Drain everything so module state is clean for other suites. Releasing more
    // times than were acquired is safe (active floors at 0, no waiter to promote).
    for (let i = 0; i < cap + queue + 2; i++) releasePngSlot()
    await Promise.all(queued)
  })
})
