/**
 * Tests for the safe DOCX extraction layer (commit ①).
 *
 * We hand-build ZIP byte streams so we can forge the exact conditions a real
 * zip-bomb / malformed docx would create — something no high-level zip library
 * lets you express (fake uncompressed sizes, absurd ratios, entry floods). A
 * minimal but spec-correct local-file-header + central-directory writer lives at
 * the bottom of this file.
 */
import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { extractDocx } from '../src/import/docx/extract.js'

// ── ZIP builder (minimal, deflate + stored) ─────────────────────────────────

interface ZipInput {
  name: string
  /** Raw uncompressed content. */
  content: Buffer
  /** Override the uncompressedSize written into the headers (bomb forging). */
  fakeUncompressedSize?: number
  /** Store uncompressed instead of deflating. */
  store?: boolean
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(inputs: ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const input of inputs) {
    const nameBuf = Buffer.from(input.name, 'utf8')
    const raw = input.content
    const deflated = input.store ? raw : zlib.deflateRawSync(raw)
    const method = input.store ? 0 : 8
    const crc = crc32(raw)
    const compSize = deflated.length
    const uncompSize = input.fakeUncompressedSize ?? raw.length

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compSize, 18)
    local.writeUInt32LE(uncompSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, deflated)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compSize, 20)
    central.writeUInt32LE(uncompSize, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + deflated.length
  }

  const cd = Buffer.concat(centrals)
  const localBytes = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(inputs.length, 8)
  eocd.writeUInt16LE(inputs.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(localBytes.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localBytes, cd, eocd])
}

/** A minimal well-formed docx body part. */
const DOC_XML = Buffer.from(
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>',
  'utf8',
)

// ── Happy path ───────────────────────────────────────────────────────────────

describe('extractDocx — happy path', () => {
  it('extracts the wanted parts and keeps media', async () => {
    const zip = buildZip([
      { name: 'word/document.xml', content: DOC_XML },
      { name: 'word/numbering.xml', content: Buffer.from('<w:numbering/>', 'utf8') },
      { name: 'word/media/image1.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
      // an unwanted part — must be counted then discarded
      { name: 'docProps/app.xml', content: Buffer.from('<Properties/>', 'utf8') },
    ])
    const out = await extractDocx(zip)
    expect(out.parts.has('word/document.xml')).toBe(true)
    expect(out.parts.has('word/numbering.xml')).toBe(true)
    expect(out.parts.has('docprops/app.xml')).toBe(false) // discarded
    expect(out.media).toHaveLength(1)
    expect(out.media[0]!.name).toBe('word/media/image1.png')
    expect(out.parts.get('word/document.xml')!.data.toString('utf8')).toContain('<w:t>hi</w:t>')
  })

  it('normalises backslash entry names and lower-cases lookup keys', async () => {
    const zip = buildZip([{ name: 'word\\document.xml', content: DOC_XML }])
    const out = await extractDocx(zip)
    expect(out.parts.has('word/document.xml')).toBe(true)
  })

  it('warns when document.xml is missing', async () => {
    const zip = buildZip([{ name: 'word/styles.xml', content: Buffer.from('<w:styles/>', 'utf8') }])
    const out = await extractDocx(zip)
    expect(out.warnings.join(' ')).toMatch(/document\.xml missing/)
  })
})

// ── Safety bounds ──────────────────────────────────────────────────────────

describe('extractDocx — safety bounds', () => {
  it('rejects a non-zip buffer', async () => {
    await expect(extractDocx(Buffer.from('not a zip at all'))).rejects.toMatchObject({
      name: 'DocxUnsafeError',
      reason: 'not-a-zip',
    })
  })

  it('rejects when a single entry inflates past the per-entry ceiling', async () => {
    // 100MB+ of zeros deflates tiny but inflates past maxEntryUncompressedBytes.
    const huge = Buffer.alloc(101 * 1024 * 1024, 0)
    const zip = buildZip([{ name: 'word/document.xml', content: huge }])
    await expect(extractDocx(zip)).rejects.toMatchObject({ reason: 'entry-too-large' })
  })

  it('rejects a forged compression ratio before full inflation', async () => {
    // Small real content but a header claiming a wildly larger uncompressed size.
    const small = Buffer.from('x'.repeat(100), 'utf8')
    const zip = buildZip([
      { name: 'word/document.xml', content: small, fakeUncompressedSize: 100 * 1024 * 1024 },
    ])
    await expect(extractDocx(zip)).rejects.toMatchObject({ reason: 'ratio-too-high' })
  })

  it('rejects too many entries', async () => {
    const many: ZipInput[] = []
    for (let i = 0; i < 5000; i++) {
      many.push({ name: `junk/f${i}.txt`, content: Buffer.from('a'), store: true })
    }
    await expect(extractDocx(buildZip(many))).rejects.toMatchObject({ reason: 'too-many-entries' })
  })
})
