import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock is hoisted to the top of the file — factories cannot reference
// outer-scope variables. We stash the shared mocks on globalThis so both
// the factory and the test bodies can reach them.
const g = globalThis as typeof globalThis & {
  __pdfMocks: {
    page: Record<string, ReturnType<typeof vi.fn>>
    browser: Record<string, ReturnType<typeof vi.fn>>
  }
}

g.__pdfMocks = {
  page: {
    setContent: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  },
  browser: {
    newPage: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  },
}

// Wire newPage to return our mock page (cannot do this inline because
// mockPage isn't defined yet when the factory runs).
g.__pdfMocks.browser.newPage.mockImplementation(async () => g.__pdfMocks.page)

vi.mock('puppeteer', () => ({
  default: {
    launch: vi.fn().mockImplementation(async () => g.__pdfMocks.browser),
  },
}))

// Override config so tests run with tight limits (fast, deterministic).
vi.mock('../src/config/env.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config/env.js')>('../src/config/env.js')
  return {
    ...actual,
    config: {
      ...actual.config,
      attachments: { bucket: 'test-bucket', s3: { endpoint: 'https://s3.example.com' } },
      pdfExport: {
        maxConcurrent: 2,
        maxQueue: 2,
        renderTimeoutMs: 500,
        recycleAfterPages: 0, // disable recycling in most tests
        executablePath: '',
      },
    },
  }
})

import { renderPdf, PdfQueueFullError, PdfTimeoutError, isAllowedResource, closeBrowser } from '../src/export/pdfService.js'

const { page: mockPage, browser: mockBrowser } = g.__pdfMocks

beforeEach(() => {
  vi.clearAllMocks()
  mockPage.setContent.mockResolvedValue(undefined)
  mockPage.pdf.mockResolvedValue(Buffer.from('%PDF-fake'))
  mockPage.close.mockResolvedValue(undefined)
  mockBrowser.newPage.mockImplementation(async () => mockPage)
})

afterEach(async () => {
  // Ensure the browser singleton is torn down between tests so each test
  // starts clean (no leaked active-slot count or cached allowedHosts).
  await closeBrowser()
})

// ── SSRF allow-list ────────────────────────────────────────────────────────────
describe('isAllowedResource — SSRF allow-list', () => {
  it('allows data:, about:, and blob: URIs (inlined resources)', () => {
    expect(isAllowedResource('data:text/css;base64,abc')).toBe(true)
    expect(isAllowedResource('about:blank')).toBe(true)
    expect(isAllowedResource('blob:https://x/y')).toBe(true)
  })

  it('allows object-store.local signed URLs', () => {
    expect(isAllowedResource('https://test-bucket.object-store.local/key?sig=abc')).toBe(true)
  })

  it('allows S3 endpoint URLs', () => {
    expect(isAllowedResource('https://s3.example.com/bucket/key')).toBe(true)
  })

  it('blocks arbitrary external hosts', () => {
    expect(isAllowedResource('https://evil.com/malware')).toBe(false)
    expect(isAllowedResource('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isAllowedResource('https://internal.corp/admin')).toBe(false)
  })

  it('blocks non-http(s) protocols', () => {
    expect(isAllowedResource('ftp://example.com/file')).toBe(false)
    expect(isAllowedResource('file:///etc/passwd')).toBe(false)
    expect(isAllowedResource('javascript:alert(1)')).toBe(false)
  })

  it('rejects malformed URLs', () => {
    expect(isAllowedResource('not-a-url')).toBe(false)
    expect(isAllowedResource('')).toBe(false)
  })
})

// ── concurrency queue ──────────────────────────────────────────────────────────
describe('renderPdf — concurrency queue', () => {
  it('renders successfully and returns a PDF buffer', async () => {
    const buf = await renderPdf('<p>hello</p>')
    expect(buf).toBeInstanceOf(Buffer)
    expect(mockPage.setContent).toHaveBeenCalledTimes(1)
    expect(mockPage.pdf).toHaveBeenCalledTimes(1)
    expect(mockPage.close).toHaveBeenCalledTimes(1)
  })

  it('rejects with PdfQueueFullError when queue is saturated', async () => {
    // maxConcurrent=2, maxQueue=2 → 2 active + 2 waiting = 4 total; 5th rejects.
    // Make renders hang so slots stay occupied.
    let resolveRender: (() => void) | undefined
    mockPage.pdf.mockImplementation(() => new Promise((r) => { resolveRender = r as never }))

    // Fill 2 active slots + 2 queue slots.
    const pending = Array.from({ length: 4 }, () =>
      renderPdf('<p>x</p>').catch(() => null),
    )
    // Small tick to let the first two acquire slots and the next two enqueue.
    await new Promise((r) => setTimeout(r, 20))

    // 5th request should be rejected immediately.
    await expect(renderPdf('<p>overflow</p>')).rejects.toThrow(PdfQueueFullError)

    // Unblock hanging renders so the test can clean up.
    resolveRender?.()
    mockPage.pdf.mockResolvedValue(Buffer.from('%PDF-fake'))
    await Promise.all(pending)
  })

  it('always closes the page even on error (leak guard)', async () => {
    mockPage.setContent.mockRejectedValue(new Error('boom'))
    await expect(renderPdf('<p>fail</p>')).rejects.toThrow('boom')
    expect(mockPage.close).toHaveBeenCalledTimes(1)
  })
})

// ── timeout ────────────────────────────────────────────────────────────────────
describe('renderPdf — hard timeout', () => {
  it('throws PdfTimeoutError when render exceeds renderTimeoutMs', async () => {
    // Make pdf() hang longer than the 500ms timeout.
    mockPage.pdf.mockImplementation(() => new Promise((r) => setTimeout(() => r(Buffer.from('x')), 5000)))
    await expect(renderPdf('<p>slow</p>')).rejects.toThrow(PdfTimeoutError)
    // Page must still be closed.
    expect(mockPage.close).toHaveBeenCalledTimes(1)
  })
})

// ── browser recycling ──────────────────────────────────────────────────────────
describe('renderPdf — browser recycling', () => {
  it('recycles the browser after recycleAfterPages when idle', async () => {
    // Re-mock config with recycleAfterPages=2 for this test.
    const { config } = await import('../src/config/env.js')
    const origRecycle = config.pdfExport.recycleAfterPages
    config.pdfExport.recycleAfterPages = 2

    try {
      await renderPdf('<p>1</p>')
      expect(mockBrowser.close).not.toHaveBeenCalled()
      await renderPdf('<p>2</p>')
      // After 2 pages with no active renders, browser should be recycled.
      expect(mockBrowser.close).toHaveBeenCalledTimes(1)
    } finally {
      config.pdfExport.recycleAfterPages = origRecycle
    }
  })
})

// ── SSRF interception wiring ───────────────────────────────────────────────────
describe('renderPdf — request interception', () => {
  it('enables request interception on every page', async () => {
    await renderPdf('<p>x</p>')
    expect(mockPage.setRequestInterception).toHaveBeenCalledWith(true)
    expect(mockPage.on).toHaveBeenCalledWith('request', expect.any(Function))
  })
})
