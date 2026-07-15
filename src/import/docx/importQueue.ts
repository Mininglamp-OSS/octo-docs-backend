/**
 * Concurrency gate for the server-side .docx import path.
 *
 * `importDocxWithMedia` holds a fully inflated document in memory and runs a
 * synchronous, CPU-heavy walk + OOXML→ProseMirror + per-formula OMML→LaTeX
 * convert. The per-request caps (upload/inflate size, entry count, list level,
 * block depth, parse deadline) bound a SINGLE import, but nothing bounds how
 * many run at once: a burst of concurrent uploads can still pin the event loop
 * and stack inflated documents in memory. This bounds concurrency: at most
 * `maxConcurrent` imports proceed, up to `maxQueue` more wait for a slot, and
 * any request beyond that is rejected (DocxImportBusyError -> HTTP 503) so the
 * burst sheds load instead of piling up. Mirrors the typst/board export queues.
 */
import { config } from '../../config/env.js'

/** Thrown when the docx import queue is saturated (-> HTTP 503). */
export class DocxImportBusyError extends Error {
  constructor() {
    super('docx import queue is full')
    this.name = 'DocxImportBusyError'
  }
}

let active = 0
const waiters: Array<() => void> = []

/** Acquire an import slot, or reject with DocxImportBusyError when saturated. */
export function acquireDocxImportSlot(): Promise<void> {
  if (active < config.docxImport.maxConcurrent) {
    active++
    return Promise.resolve()
  }
  if (waiters.length >= config.docxImport.maxQueue) {
    return Promise.reject(new DocxImportBusyError())
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active++
      resolve()
    })
  })
}

/** Release an import slot and hand it to the next waiter, if any. */
export function releaseDocxImportSlot(): void {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}
