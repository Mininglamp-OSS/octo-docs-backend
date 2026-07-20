// Access-log URL sanitizer. Kept in its own module (no heavy imports) so it can
// be unit-tested in isolation and reused by the access-log middleware in app.ts.

// Query-string keys whose values are secrets (short-lived HMAC signatures, AWS
// presign params, generic tokens). Redacted from the access log so a signed blob
// URL / invite link can't be replayed from log access. Matched case-insensitively.
const REDACTED_QUERY_KEYS = /^(x-signature|x-amz-.+|signature|token|access_token)$/i

// Sanitize a request URL for logging: keep method+path+status readable (so a
// decide callback is still identifiable) while redacting secret query values and
// invite tokens embedded in the path.
export function sanitizeUrlForLog(originalUrl: string): string {
  const qIndex = originalUrl.indexOf('?')
  let path = qIndex === -1 ? originalUrl : originalUrl.slice(0, qIndex)
  const query = qIndex === -1 ? '' : originalUrl.slice(qIndex + 1)

  // Redact invite tokens in the path: /invites/:token/accept, /invites/:token, etc.
  path = path.replace(/(\/invites\/)[^/?]+/gi, '$1[REDACTED]')

  if (!query) return stripLogControlChars(path)

  // Decode defensively: a malformed percent-escape (e.g. a bare `%`) makes
  // decodeURIComponent throw. The caller runs this inside res.on('finish'),
  // where a throw would drop the log line and surface as an uncaughtException.
  // On a bad key, fall back to the raw (still-encoded) key for the match.
  const safeDecode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }

  const sanitizedParams = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const key = eq === -1 ? pair : pair.slice(0, eq)
      if (eq !== -1 && REDACTED_QUERY_KEYS.test(safeDecode(key))) {
        return `${key}=[REDACTED]`
      }
      return pair
    })
    .join('&')

  return stripLogControlChars(`${path}?${sanitizedParams}`)
}

// Strip CR/LF and other control characters before the value reaches console.log.
// `req.originalUrl` is attacker-controlled, so a raw `\r\n` (or other C0 control
// char) in the URL would let a caller forge extra log lines / spoof entries (log
// injection, flagged by CodeQL). Replace every control char with a visible
// escape so a single request can only ever produce a single log line.
export function stripLogControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    if (ch === '\n') return '\\n'
    if (ch === '\r') return '\\r'
    if (ch === '\t') return '\\t'
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
  })
}
