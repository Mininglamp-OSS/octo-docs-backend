/**
 * Puppeteer PDF render service (server-side export).
 *
 * The headless Chrome browser is a SINGLETON reused across requests — launching
 * per request would cost seconds and ~300MB each time. On top of it this module
 * layers the protections the design review mandates:
 *
 *   1. Concurrency queue — at most `maxConcurrent` renders run at once; the rest
 *      wait, and once `maxQueue` are already waiting new requests are rejected
 *      (PdfQueueFullError, which the route maps to HTTP 503) so a burst can't
 *      exhaust memory.
 *   2. Per-render hard timeout — a stuck render is abandoned after
 *      `renderTimeoutMs`; the page is always closed in a finally (leak guard),
 *      and if the browser itself has died it is relaunched on the next render.
 *   3. Request interception (SSRF) — the page may only load sub-resources from
 *      the trusted object store (signed URLs); every other http(s) request is
 *      aborted so document content can never make the headless browser fetch an
 *      arbitrary external/internal URL. Fonts/CSS are inlined as data URIs, so no
 *      other request is legitimate.
 *   4. Browser recycling — after `recycleAfterPages` pages the browser is closed
 *      and relaunched to bound Chrome's slow memory creep.
 *
 * Graceful shutdown: closeBrowser() is called from the process SIGTERM/SIGINT
 * handler (src/index.ts) so Chrome does not linger after the server exits. We
 * deliberately do NOT self-register signal handlers here — index.ts owns the one
 * ordered shutdown path (flush docs, close browser, close infra), and a second
 * handler calling process.exit() would race it.
 *
 * Local dev uses the full `puppeteer` package (bundled Chromium). In the alpine
 * image we install the system chromium and point PUPPETEER_EXECUTABLE_PATH at it
 * (see Dockerfile); the same `puppeteer` import then drives the system binary.
 */
import puppeteer, { type Browser, type Page, type HTTPRequest } from 'puppeteer'
import { config } from '../config/env.js'

/** Thrown when the wait queue is already full — the route maps this to 503. */
export class PdfQueueFullError extends Error {
  constructor() {
    super('pdf export queue is full')
    this.name = 'PdfQueueFullError'
  }
}

/** Thrown when a single render exceeds the hard timeout. */
export class PdfTimeoutError extends Error {
  constructor() {
    super('pdf render timed out')
    this.name = 'PdfTimeoutError'
  }
}

// ── allowed sub-resource hosts (SSRF allow-list) ───────────────────────────────
/**
 * The only hosts the headless browser may fetch from: the object store that
 * serves signed attachment URLs. Derived from the SAME attachment config the
 * presign layer uses, so it tracks whichever driver is active (the local-hmac
 * synthetic host, or the real S3/MinIO endpoint) with no separate env to keep in
 * sync.
 */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  // local-hmac driver mints https://<bucket>.object-store.local/<key> URLs.
  hosts.add(`${config.attachments.bucket}.object-store.local`)
  // s3 / minio driver mints URLs against the configured public endpoint.
  // Only add when the S3 driver is actually active — otherwise localhost:9000
  // (the default S3 endpoint) would be allowlisted even though no signed URLs
  // point there, letting a crafted image src probe internal services.
  if (config.attachments.driver !== 'local-hmac') {
    try {
      hosts.add(new URL(config.attachments.s3.endpoint).host)
    } catch {
      /* endpoint not a valid URL — ignore */
    }
  }
  return hosts
}

let allowedHostsCache: Set<string> | null = null
export function isAllowedResource(url: string): boolean {
  // Inlined resources (fonts/CSS) and the blank base document need no fetch.
  if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (!allowedHostsCache) allowedHostsCache = allowedHosts()
  return allowedHostsCache.has(parsed.host)
}

// ── browser singleton ──────────────────────────────────────────────────────────
let browserPromise: Promise<Browser> | null = null
let pagesRendered = 0

async function launch(): Promise<Browser> {
  const browser = await puppeteer.launch({
    // --no-sandbox / --disable-setuid-sandbox: required to run as root in a
    // container. --disable-dev-shm-usage: /dev/shm is tiny in Docker and Chrome
    // crashes without it. --disable-gpu / --font-render-hinting=none: steadier
    // headless text rendering.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
    // Empty string => undefined => puppeteer's bundled Chromium (local dev).
    executablePath: config.pdfExport.executablePath || undefined,
  })
  // If Chrome dies/crashes, drop the cached promise so the next render relaunches.
  browser.on('disconnected', () => {
    browserPromise = null
    pagesRendered = 0
  })
  return browser
}

/** Get the shared browser, launching (or relaunching after a crash) on demand. */
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Bound the launch itself: if puppeteer.launch() hangs indefinitely (not a
    // crash — the disconnected handler covers that — but a wedged spawn), a bare
    // cached promise would stay pending forever and wedge EVERY subsequent
    // export until process restart. Race a launch deadline; on timeout reset
    // browserPromise so the next request retries a fresh launch. The deadline
    // reuses the per-render timeout (a launch that outlasts a whole render's
    // budget is wedged) with a 5s floor so a tiny renderTimeout can't make
    // normal cold starts flap.
    const launchTimeoutMs = Math.max(5_000, config.pdfExport.renderTimeoutMs)
    // Hold the RAW launch() promise so a late-resolving browser (one that lost
    // the race but eventually spawns) can be reaped. Without this, resetting
    // browserPromise on timeout would orphan that Chromium process — nobody
    // holds it, nobody closes it, and its disconnected handler only nulls an
    // already-null browserPromise. Under sustained slow-start that leaks one
    // process per launch cycle, unbounded, until PID/memory exhaustion.
    const rawLaunch = launch()
    let timedOut = false
    // Reaper: if the race already timed out, close the browser once it arrives.
    // If the race won (timedOut still false), this is a no-op passthrough.
    void rawLaunch
      .then((b) => {
        if (timedOut) void b.close().catch(() => {})
      })
      .catch(() => {
        /* launch failed; nothing to reap */
      })
    browserPromise = Promise.race<Browser>([
      rawLaunch,
      new Promise<Browser>((_, rej) =>
        setTimeout(() => {
          timedOut = true
          rej(new Error('browser launch timeout'))
        }, launchTimeoutMs),
      ),
    ]).catch((err) => {
      // Reset so a failed/hung launch doesn't poison every future request. The
      // reaper above closes the late-resolving browser so nothing is orphaned.
      browserPromise = null
      throw err
    })
  }
  return browserPromise
}

/** Close the shared browser (graceful shutdown, or a recycle). */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise
  browserPromise = null
  pagesRendered = 0
  if (!pending) return
  try {
    const browser = await pending
    await browser.close()
  } catch {
    /* already gone */
  }
}

// ── concurrency queue ──────────────────────────────────────────────────────────
let active = 0
const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

export function acquireSlot(): Promise<void> {
  if (active < config.pdfExport.maxConcurrent) {
    active++
    return Promise.resolve()
  }
  if (waiters.length >= config.pdfExport.maxQueue) {
    return Promise.reject(new PdfQueueFullError())
  }
  // The freed slot is handed straight to this waiter on release, so `active`
  // stays accurate without a second increment here.
  return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
}

export function releaseSlot(): void {
  const next = waiters.shift()
  if (next) next.resolve()
  else active--
}

/**
 * Recycle the browser after enough pages have been rendered and no render is
 * in flight. Called from the route's finally (after releaseSlot) so that the
 * skipSlot=true production path also triggers recycling — previously the check
 * lived inside renderPdf's finally where active was always >=1 under skipSlot,
 * making recycling dead on the only real code path.
 */
export async function maybeRecycleBrowser(): Promise<void> {
  const recycleAfter = config.pdfExport.recycleAfterPages
  if (recycleAfter > 0 && pagesRendered >= recycleAfter && active === 0) {
    await closeBrowser()
  }
}

// ── render ─────────────────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PdfTimeoutError()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function renderOnce(page: Page, html: string): Promise<Buffer> {
  const timeout = config.pdfExport.renderTimeoutMs
  // Fonts/CSS are inlined as data URIs and disallowed hosts abort immediately,
  // so the only real network work is object-store images. The `load` event
  // already waits for those (and fires once they've loaded or errored), and
  // puppeteer 25 restricts setContent's waitUntil to load/domcontentloaded.
  await page.setContent(html, { waitUntil: 'load', timeout })
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    // Honour the @page size + margins from the print CSS rather than fighting
    // them with a second set of PDF-level margins.
    preferCSSPageSize: true,
    timeout,
  })
  return Buffer.from(pdf)
}

/**
 * Render an HTML string to a PDF Buffer. When called from the export route the
 * concurrency slot is already held (acquired at the pipeline entry); pass
 * `skipSlot=true` to avoid double-acquire. Standalone callers omit it and
 * renderPdf manages its own slot.
 */
export async function renderPdf(html: string, skipSlot = false): Promise<Buffer> {
  if (!skipSlot) await acquireSlot()
  let page: Page | null = null
  // Holds THIS call's newPage() promise so the finally can recover this render's
  // OWN page even when the hard timeout fires before the outer await assigns
  // `page`. Closing only this promise's page — never every page on the shared
  // browser singleton — avoids tearing down concurrent renders' in-flight pages.
  let newPageP: Promise<Page> | null = null
  try {
    const timeout = config.pdfExport.renderTimeoutMs
    // Wrap the ENTIRE page lifecycle (launch reuse + newPage + interception setup
    // + render + pdf generation) in the hard timeout. Previously only setContent
    // and page.pdf were wrapped, so a stuck newPage() or setRequestInterception()
    // could hang the route past the timeout.
    const buffer = await withTimeout((async () => {
      const browser = await getBrowser()
      newPageP = browser.newPage()
      page = await newPageP

      // SSRF guard: only the object store may be fetched; everything else aborts.
      await page.setRequestInterception(true)
      page.on('request', (req: HTTPRequest) => {
        if (isAllowedResource(req.url())) void req.continue()
        else void req.abort()
      })

      return renderOnce(page, html)
    })(), timeout)
    pagesRendered++
    return buffer
  } finally {
    // Always close THIS render's page (leak guard) even on timeout; guard the
    // close itself since a wedged page can reject. Race the close against a
    // short deadline so a hung page.close() doesn't block the slot indefinitely.
    if (page) {
      await closePageBounded(page)
    } else if (newPageP) {
      // Timeout fired before newPage() resolved and assigned `page`. Recover this
      // render's own page from its newPage() promise (bounded wait so a truly
      // hung newPage() can't block the slot), then close only that page. This
      // must NOT enumerate/close browser.pages() — that would kill concurrent
      // renders sharing the singleton browser.
      const straggler = newPageP
      void (async () => {
        try {
          const p = await Promise.race<Page | null>([
            straggler,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
          ])
          if (p) await closePageBounded(p)
        } catch {
          /* newPage() rejected or wedged; best-effort */
        }
      })()
    }
    if (!skipSlot) releaseSlot()
  }
}

/** Close a page, racing a 5s deadline so a wedged page.close() can't block. */
async function closePageBounded(p: Page): Promise<void> {
  try {
    await Promise.race([
      p.close(),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('page.close timeout')), 5000)),
    ])
  } catch {
    /* page already gone or close timed out */
  }
}
