/**
 * Concurrency gate for the board PNG export path.
 *
 * `rasterizeSvgToPng` is synchronous, CPU- and memory-heavy Skia work (SVG
 * raster + per-image compositing). The endpoint is reader-accessible via a plain
 * GET, so a burst of `?format=png` requests can otherwise run unbounded, saturate
 * CPU, stack decoded bitmaps in memory, and cascade into an OOM even with each
 * individual raster already pixel-bounded. This bounds how many run at once: at
 * most `maxConcurrent` proceed, up to `maxQueue` more wait for a slot, and any
 * request beyond that is rejected (BoardExportBusyError -> HTTP 503) so the burst
 * sheds load instead of piling up. Mirrors the typst export queue.
 */
import { config } from '../config/env.js'

/** Thrown when the board PNG export queue is saturated (-> HTTP 503). */
export class BoardExportBusyError extends Error {
  constructor() {
    super('board png export queue is full')
    this.name = 'BoardExportBusyError'
  }
}

let active = 0
const waiters: Array<() => void> = []

/** Acquire a raster slot, or reject with BoardExportBusyError when saturated. */
export function acquirePngSlot(): Promise<void> {
  if (active < config.boardExport.maxConcurrentPngExports) {
    active++
    return Promise.resolve()
  }
  if (waiters.length >= config.boardExport.maxQueuedPngExports) {
    return Promise.reject(new BoardExportBusyError())
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active++
      resolve()
    })
  })
}

/** Release a raster slot and hand it to the next waiter, if any. */
export function releasePngSlot(): void {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}
