/**
 * Object-storage presign driver abstraction (§3.5).
 *
 * Binary blobs (images, files) never enter the Y.Doc or a DB large field —
 * they are uploaded directly to object storage and the Y.Doc keeps only a
 * reference (attach_id / object key). This module mints the URLs that flow:
 *   · step 1 — a presigned PUT URL the front-end uploads to directly;
 *   · step 5 — a freshly signed, time-limited GET URL re-issued at read time.
 *
 * The default `local-hmac` driver produces real, verifiable signatures using
 * Node's built-in `crypto` (no cloud creds, no aws-sdk/cos-sdk). The signed URL
 * embeds an expiry timestamp and an HMAC over (objectKey + expiry) keyed by a
 * config secret; `verifySignedUrl()` lets callers/tests assert validity and
 * expiry. A real COS/S3 driver can be slotted in behind the same `ObjectStore`
 * interface and selected via `config.attachments.driver`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config/env.js'

export interface PresignedUpload {
  /** Fully-formed URL the client issues a PUT against. */
  uploadUrl: string
  /** Optional headers the client must echo on the PUT (e.g. Content-Type). */
  headers?: Record<string, string>
}

export interface ObjectStore {
  /** Mint a presigned PUT URL for `objectKey`, valid for `expiresSec`. */
  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload
  /**
   * Mint a signed, time-limited GET URL for `objectKey` (§3.5 step 5). When
   * `opts.contentDisposition` is set the value is bound into the signature and
   * carried as `response-content-disposition` so object storage replays it as
   * the response `Content-Disposition` header — used to force a download for
   * non-inline attachment types (§3.5).
   */
  presignGet(objectKey: string, expiresSec: number, opts?: PresignGetOptions): string
}

export interface PresignGetOptions {
  /** Full Content-Disposition value, e.g. `attachment; filename="report.pdf"`. */
  contentDisposition?: string
}

export interface VerifyResult {
  valid: boolean
  /** Set when invalid, for diagnostics/tests: 'missing' | 'expired' | 'bad_signature'. */
  reason?: 'missing' | 'expired' | 'bad_signature'
}

/**
 * Compute the canonical HMAC signature over (method + objectKey + expiry), plus
 * any `extra` material (e.g. a content-disposition value) appended only when
 * present so legacy URLs without it keep their original, unchanged signature.
 * The method is bound so a GET signature can't be replayed as a PUT.
 */
function sign(
  method: 'PUT' | 'GET',
  objectKey: string,
  expiry: number,
  secret: string,
  extra = '',
): string {
  const base = `${method}\n${objectKey}\n${expiry}`
  return createHmac('sha256', secret)
    .update(extra ? `${base}\n${extra}` : base)
    .digest('hex')
}

/** Constant-time hex-string comparison (avoids signature timing leaks). */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Default dev/self-hosted driver: deterministic, TTL-bounded HMAC-signed URLs.
 * The base host is derived from the configured bucket; the path is the object
 * key, and the query carries the expiry + signature. `nowSec` is injectable so
 * tests can assert expiry behaviour deterministically.
 */
export class LocalHmacObjectStore implements ObjectStore {
  private readonly bucket: string
  private readonly secret: string
  private readonly nowSec: () => number

  constructor(opts?: { bucket?: string; secret?: string; nowSec?: () => number }) {
    this.bucket = opts?.bucket ?? config.attachments.bucket
    this.secret = opts?.secret ?? config.attachments.signingSecret
    this.nowSec = opts?.nowSec ?? (() => Math.floor(Date.now() / 1000))
  }

  private baseUrl(objectKey: string): string {
    // Path-style URL against the bucket host. Each key segment is encoded but
    // the '/' separators are preserved so the key round-trips cleanly.
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
    return `https://${this.bucket}.object-store.local/${encodedKey}`
  }

  private signedUrl(
    method: 'PUT' | 'GET',
    objectKey: string,
    expiresSec: number,
    contentDisposition?: string,
  ): string {
    const expiry = this.nowSec() + expiresSec
    const signature = sign(method, objectKey, expiry, this.secret, contentDisposition ?? '')
    const url = new URL(this.baseUrl(objectKey))
    url.searchParams.set('X-Method', method)
    url.searchParams.set('X-Expiry', String(expiry))
    // Bound into the HMAC above; the self-hosted gateway in front of this driver
    // MUST replay it as `Content-Disposition` AND add `X-Content-Type-Options:
    // nosniff` on every attachment response — signing only proves the value
    // wasn't tampered with, it does not make the gateway emit the header (§3.5
    // S1). Without that gateway work the local-hmac path has no XSS defence.
    if (contentDisposition) {
      url.searchParams.set('response-content-disposition', contentDisposition)
    }
    url.searchParams.set('X-Signature', signature)
    return url.toString()
  }

  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload {
    return {
      uploadUrl: this.signedUrl('PUT', objectKey, expiresSec),
      headers: { 'Content-Type': mime },
    }
  }

  presignGet(objectKey: string, expiresSec: number, opts?: PresignGetOptions): string {
    return this.signedUrl('GET', objectKey, expiresSec, opts?.contentDisposition)
  }

  /**
   * Verify a previously minted URL: checks the signature matches and the expiry
   * has not passed. Bound to this driver's secret. Exposed for tests and for a
   * future read-proxy that validates inbound signed URLs.
   */
  verify(signedUrl: string): VerifyResult {
    let url: URL
    try {
      url = new URL(signedUrl)
    } catch {
      return { valid: false, reason: 'missing' }
    }
    const method = url.searchParams.get('X-Method')
    const expiryStr = url.searchParams.get('X-Expiry')
    const signature = url.searchParams.get('X-Signature')
    if (!method || !expiryStr || !signature || (method !== 'PUT' && method !== 'GET')) {
      return { valid: false, reason: 'missing' }
    }
    const expiry = Number(expiryStr)
    if (!Number.isFinite(expiry)) return { valid: false, reason: 'missing' }

    // Reconstruct the object key from the path (decode each segment).
    const objectKey = url.pathname
      .replace(/^\//, '')
      .split('/')
      .map(decodeURIComponent)
      .join('/')

    // Disposition (when present) is part of the signed material; '' otherwise so
    // legacy URLs without it verify against the original signature form.
    const disposition = url.searchParams.get('response-content-disposition') ?? ''
    const expected = sign(method, objectKey, expiry, this.secret, disposition)
    if (!safeEqualHex(expected, signature)) return { valid: false, reason: 'bad_signature' }
    if (this.nowSec() >= expiry) return { valid: false, reason: 'expired' }
    return { valid: true }
  }
}

/**
 * RFC-3986 URI encoding as required by AWS SigV4. `encodeURIComponent` already
 * leaves the unreserved set (A-Z a-z 0-9 - _ . ~) untouched, but it does NOT
 * escape `! * ' ( )` — AWS does — so we percent-escape those too. Slashes in a
 * path are encoded segment-by-segment by the caller so the separators survive.
 */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Real S3-compatible driver (MinIO, AWS S3, …) that mints AWS Signature V4
 * presigned query-string URLs using only Node's built-in crypto — no aws-sdk /
 * minio package. MinIO is fully SigV4 compatible, so a correctly built
 * presigned URL works against it unchanged.
 *
 * Addressing is path-style (`<endpoint>/<bucket>/<key>`); the host baked into
 * the signed URL is the configured *public*, browser-reachable endpoint (never
 * a docker-internal alias), since the front-end issues the PUT/GET directly.
 * Presigning is pure signing with no network call. `nowSec` is injectable so
 * tests can assert the embedded `X-Amz-Date` deterministically.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: string
  private readonly region: string
  private readonly bucket: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly nowSec: () => number
  private static readonly SERVICE = 's3'

  constructor(opts: {
    endpoint: string
    region: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    nowSec?: () => number
  }) {
    // Strip any trailing slash so path joining stays canonical.
    this.endpoint = opts.endpoint.replace(/\/+$/, '')
    this.region = opts.region
    this.bucket = opts.bucket
    this.accessKeyId = opts.accessKeyId
    this.secretAccessKey = opts.secretAccessKey
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000))
  }

  /** Path-style canonical URI: /<bucket>/<encoded key segments>. */
  private canonicalUri(objectKey: string): string {
    const encodedKey = objectKey.split('/').map(awsUriEncode).join('/')
    return `/${awsUriEncode(this.bucket)}/${encodedKey}`
  }

  private presign(
    method: 'PUT' | 'GET',
    objectKey: string,
    expiresSec: number,
    contentDisposition?: string,
  ): string {
    const url = new URL(this.endpoint)
    // Host header carries the port when non-default; it must match the URL host
    // exactly or the signature will not verify.
    const host = url.host

    const now = new Date(this.nowSec() * 1000)
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8) // YYYYMMDD
    const credentialScope = `${dateStamp}/${this.region}/${S3ObjectStore.SERVICE}/aws4_request`

    // X-Amz-* query params that participate in the signature. Content-Type is
    // intentionally NOT signed (SignedHeaders=host only) so the browser can set
    // it freely on the PUT.
    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSec),
      'X-Amz-SignedHeaders': 'host',
    }
    // S3/MinIO natively replays `response-content-disposition` as the response
    // Content-Disposition header; signing it (it joins the canonical query
    // below) is sufficient to force a download for non-inline types (§3.5).
    if (contentDisposition) {
      params['response-content-disposition'] = contentDisposition
    }

    const canonicalQuery = Object.entries(params)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
      .join('&')

    const canonicalUri = this.canonicalUri(objectKey)
    const canonicalHeaders = `host:${host}\n`
    const signedHeaders = 'host'
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n')

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n')

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, S3ObjectStore.SERVICE)
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    return `${url.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
  }

  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload {
    return {
      uploadUrl: this.presign('PUT', objectKey, expiresSec),
      // Echoed by the client on the PUT but deliberately left out of the
      // signed headers (see presign()).
      headers: { 'Content-Type': mime },
    }
  }

  presignGet(objectKey: string, expiresSec: number, opts?: PresignGetOptions): string {
    return this.presign('GET', objectKey, expiresSec, opts?.contentDisposition)
  }
}

let defaultStore: LocalHmacObjectStore | null = null
let s3Store: S3ObjectStore | null = null

/**
 * Resolve the configured ObjectStore driver. The interface is identical across
 * drivers so callers (the presign/read routes) need no change when switching:
 *   · 'local-hmac' (default) — zero-dependency HMAC-signed URLs for dev;
 *   · 's3' / 'minio' — real AWS SigV4 presigned URLs against an S3-compatible
 *     endpoint (the signed URL host is the public, browser-reachable endpoint).
 */
export function getObjectStore(): ObjectStore {
  switch (config.attachments.driver) {
    case 's3':
    case 'minio':
      if (!s3Store) {
        s3Store = new S3ObjectStore({
          endpoint: config.attachments.s3.endpoint,
          region: config.attachments.s3.region,
          bucket: config.attachments.bucket,
          accessKeyId: config.attachments.s3.accessKeyId,
          secretAccessKey: config.attachments.s3.secretAccessKey,
        })
      }
      return s3Store
    case 'local-hmac':
    default:
      if (!defaultStore) defaultStore = new LocalHmacObjectStore()
      return defaultStore
  }
}

/**
 * Verify a signed URL against the default driver's secret. Convenience wrapper
 * used by tests; returns false for drivers that don't support local verification.
 */
export function verifySignedUrl(signedUrl: string): VerifyResult {
  const store = getObjectStore()
  if (store instanceof LocalHmacObjectStore) return store.verify(signedUrl)
  return { valid: false, reason: 'missing' }
}
