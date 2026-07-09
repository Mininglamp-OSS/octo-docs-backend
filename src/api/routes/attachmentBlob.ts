/**
 * Self-hosted attachment blob gateway (XIN-717).
 *
 * With `ATTACHMENT_DRIVER=local-hmac` and `ATTACHMENT_PUBLIC_BASE_URL` pointed at
 * this backend origin, the front-end issues the presigned attachment PUT (upload)
 * and GET (download) directly at the docs-backend — there is no external object
 * store to receive them. This middleware is that receiver: it verifies the
 * HMAC-signed URL minted by LocalHmacObjectStore, then stores (PUT) or serves
 * (GET) the bytes via the local filesystem blob store.
 *
 * Only signed requests are handled — a request is claimed only when it carries
 * the `X-Method` + `X-Signature` query params the driver mints, so the gateway
 * never shadows the metadata API (/api/v1/docs), the bot mount (/v1/bot/docs) or
 * /healthz, none of which carry those params. Everything else falls through.
 *
 * CORS (Access-Control-Allow-Origin on the PUT/GET responses, and the OPTIONS
 * preflight) is applied by the shared corsMiddleware mounted ahead of this one
 * in the app, so this file only owns the signature check, byte I/O and the
 * download-safety headers (Content-Disposition replay + X-Content-Type-Options:
 * nosniff) the §3.5 S1 contract requires of the gateway in front of local-hmac.
 */
import type { Request, Response, NextFunction } from 'express'
import { config } from '../../config/env.js'
import { LocalHmacObjectStore } from '../../storage/objectStore.js'
import { getLocalBlobStore } from '../../storage/localBlobStore.js'

/**
 * Whether the local blob gateway should be mounted for the current config. Only
 * the local-hmac driver serves bytes from this process; the s3/minio drivers
 * upload straight to real object storage and never hit this path.
 */
export function localBlobGatewayEnabled(): boolean {
  return config.attachments.driver === 'local-hmac'
}

/** Collect the raw request body, rejecting once it exceeds `limit` bytes. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Reconstruct the full signed URL from the request as the browser called it.
 * The verifier ignores host/protocol (it only re-signs over method + key +
 * expiry [+ disposition]), so a fixed placeholder origin is fine; only the
 * pathname + query — which carry the signed material — matter.
 */
function signedUrlOf(req: Request): string {
  return `http://blob.local${req.originalUrl}`
}

/**
 * Express middleware implementing the gateway. Claims only signed PUT/GET
 * requests; passes everything else through with next().
 */
export function attachmentBlobGateway(req: Request, res: Response, next: NextFunction): void {
  // Not a signed attachment request — leave it for the rest of the app.
  if (
    typeof req.query['X-Signature'] !== 'string' ||
    typeof req.query['X-Method'] !== 'string' ||
    (req.method !== 'PUT' && req.method !== 'GET')
  ) {
    next()
    return
  }

  const store = new LocalHmacObjectStore()
  const verdict = store.verifyRequest(req.method, signedUrlOf(req))
  if (!verdict.valid || !verdict.objectKey) {
    // 403 for a bad/expired signature; the CORS headers are already set by the
    // upstream corsMiddleware so the browser can read the error.
    res.status(403).json({ error: 'invalid_signature', reason: verdict.reason })
    return
  }
  const objectKey = verdict.objectKey

  if (req.method === 'PUT') {
    void handlePut(req, res, objectKey)
    return
  }
  void handleGet(res, objectKey, verdict.disposition, verdict.contentType)
}

async function handlePut(req: Request, res: Response, objectKey: string): Promise<void> {
  // A single hard cap covering the larger (file) tier; the presign endpoint has
  // already enforced the precise per-mime tier before minting the URL.
  const limit = config.attachments.maxFileSizeBytes
  let body: Buffer
  try {
    body = await readBody(req, limit)
  } catch (err) {
    if ((err as { code?: string }).code === 'payload_too_large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    res.status(400).json({ error: 'upload_read_failed' })
    return
  }
  const contentType =
    typeof req.headers['content-type'] === 'string'
      ? req.headers['content-type']
      : 'application/octet-stream'
  await getLocalBlobStore().put(objectKey, contentType, body)
  res.status(200).json({ ok: true, bytes: body.length })
}

async function handleGet(
  res: Response,
  objectKey: string,
  disposition: string | undefined,
  contentType: string | undefined,
): Promise<void> {
  const object = await getLocalBlobStore().get(objectKey)
  if (!object) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  // §3.5 S1 / XIN-726: serve the trusted, presign-registered mime bound into the
  // signed GET URL — NOT the raw Content-Type the client sent on the PUT, which
  // is attacker-controlled (a client can presign as image/png yet PUT an HTML
  // body with Content-Type: text/html, so echoing the stored header is a stored
  // XSS). The registered mime was vetted by the denylist/allow-list at presign
  // time, so it is the authoritative type to serve.
  res.setHeader('Content-Type', contentType ?? object.contentType)
  // The gateway MUST add nosniff on every attachment response and replay the
  // signed Content-Disposition so a forged inline type can never render —
  // signing alone does not emit these headers.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (disposition) {
    res.setHeader('Content-Disposition', disposition)
  } else if (!contentType) {
    // Legacy URL with no trusted registered mime bound: never risk inline-
    // rendering an unverified stored type — force a download instead.
    res.setHeader('Content-Disposition', 'attachment')
  }
  res.status(200).send(object.bytes)
}
