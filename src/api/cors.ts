/**
 * Cross-Origin Resource Sharing (CORS) support for the REST API and the
 * self-hosted attachment blob gateway (XIN-717).
 *
 * The front-end runs on its own origin (e.g. http://<host>:3010) and talks to
 * this backend on a different origin (the REST API and — with the `local-hmac`
 * driver pointed at the docs-backend origin — the presigned attachment PUT/GET).
 * The browser therefore issues a CORS preflight OPTIONS before the real request
 * and blocks any response that does not echo an allowed `Access-Control-Allow-
 * Origin`. Without this layer the preflight 404s / carries no ACAO and the
 * browser blocks the upload, so cross-device image sync silently fails.
 *
 * The allowed origins are configured (never hardcoded) via `CORS_ALLOWED_ORIGINS`
 * — a comma-separated allowlist of exact origins, or the single value `*` to
 * reflect any origin. We deliberately echo the caller's Origin (with `Vary:
 * Origin`) rather than emitting a literal `*`, and we do NOT set
 * `Access-Control-Allow-Credentials`: the presigned PUT/GET authenticates via
 * the signature in the query string (no cookies), and the metadata API
 * authenticates via the `token` header, so credentialed CORS is not required and
 * a permissive `*` would be unsafe if it ever were.
 */
import type { Request, Response, NextFunction } from 'express'
import { config } from '../config/env.js'

export { parseAllowedOrigins } from '../config/env.js'

/**
 * Resolve the value to echo in `Access-Control-Allow-Origin` for a request, or
 * null when the origin is not allowed (the caller then omits the header and the
 * browser blocks the cross-origin response). `*` in the allowlist reflects any
 * origin; otherwise the match is exact.
 */
export function resolveAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null
  const allowlist = config.cors.allowedOrigins
  if (allowlist.includes('*')) return origin
  return allowlist.includes(origin) ? origin : null
}

/** Methods advertised on the preflight; a superset covering both the metadata API and the blob gateway. */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'

/** Default request headers allowed when the preflight does not name any explicitly. */
const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization, X-Space-Id, token'

/**
 * Express middleware that applies CORS to every response and short-circuits the
 * preflight. Mounted FIRST (ahead of the body parser, rate limiter and auth) so
 * an OPTIONS preflight is answered with a 2xx + CORS headers without being
 * throttled, body-parsed, or rejected by the auth chain.
 *
 * For a preflight from an allowed origin we echo the origin, advertise the
 * methods and (reflecting the browser's `Access-Control-Request-Headers`, or a
 * sane default) the allowed headers, and return 204. A preflight from a
 * disallowed origin still returns 204 but carries no ACAO, so the browser blocks
 * the follow-up request — the enforcement the same-origin policy expects.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const allowOrigin = resolveAllowedOrigin(origin)
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin)
    // The response varies by request Origin, so caches must key on it.
    res.setHeader('Vary', 'Origin')
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
    const requested = req.headers['access-control-request-headers']
    res.setHeader(
      'Access-Control-Allow-Headers',
      typeof requested === 'string' && requested !== '' ? requested : DEFAULT_ALLOWED_HEADERS,
    )
    res.setHeader('Access-Control-Max-Age', '600')
    res.status(204).end()
    return
  }

  next()
}
