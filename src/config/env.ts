/**
 * Centralized environment configuration (§2.1 / §3.4 / §4.4 / §4.7 / §9.5).
 *
 * All process.env access is funneled through here so the rest of the codebase
 * reads a typed, validated config object.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`)
  return n
}

export type OctoIdentityMode = 'http' | 'middleware'

/** Dev-only fallback secret; must never reach production (see requireSafeSigningSecret). */
const DEV_SIGNING_SECRET = 'dev-only-change-me'

/**
 * Fail-fast guard: in production the attachment signing secret must be a real
 * override, never the dev default. Returning the secret keeps the typed-config
 * pattern (call site stays a single expression) while throwing at config load
 * if prod is misconfigured. NODE_ENV is read here so the rest of the codebase
 * still never touches process.env directly.
 */
export function requireSafeSigningSecret(secret: string): string {
  if (secret === DEV_SIGNING_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error(
      'ATTACHMENT_SIGNING_SECRET must be overridden in production (refusing to run with the dev default)',
    )
  }
  return secret
}

export const config = {
  hostname: str('HOSTNAME', 'octo-docs-local'),
  hocuspocusPort: num('HOCUSPOCUS_PORT', 1234),
  httpPort: num('HTTP_PORT', 3000),

  mysql: {
    host: str('MYSQL_HOST', '127.0.0.1'),
    port: num('MYSQL_PORT', 3306),
    user: str('MYSQL_USER', 'octo_docs'),
    password: str('MYSQL_PASSWORD', 'octo_docs'),
    database: str('MYSQL_DATABASE', 'octo_docs'),
    connectionLimit: num('MYSQL_CONNECTION_LIMIT', 10),
  },

  redis: {
    host: str('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 6379),
    prefix: str('REDIS_PREFIX', 'octo-docs'),
  },

  collabToken: {
    secret: str('COLLAB_TOKEN_SECRET', 'dev-only-change-me'),
    ttlSeconds: num('COLLAB_TOKEN_TTL_SECONDS', 300),
  },

  octoIdentity: {
    mode: str('OCTO_IDENTITY_MODE', 'http') as OctoIdentityMode,
    serverBaseUrl: str('OCTO_SERVER_BASE_URL', 'http://127.0.0.1:8080'),
    // Optional service token sent as the `token` header on octo-server lookups
    // (e.g. GET /v1/users/:uid, which requires auth). Empty = not configured;
    // callers then fall back to the authenticated user's own session token.
    serviceToken: str('OCTO_SERVER_TOKEN', ''),
  },

  attachments: {
    bucket: str('ATTACHMENT_BUCKET', 'octo-docs-attachments'),
    // Object-storage presign driver (§3.5). 'local-hmac' mints real, verifiable
    // HMAC-signed URLs with Node's built-in crypto (no cloud creds/SDK needed);
    // 's3'/'minio' signs real AWS SigV4 presigned URLs against an S3-compatible
    // endpoint, behind the same ObjectStore interface.
    driver: str('ATTACHMENT_DRIVER', 'local-hmac'),
    // S3-compatible (MinIO/S3) driver settings. Used only when driver is
    // 's3'/'minio'. Path-style addressing is always used. The endpoint is the
    // PUBLIC, browser-reachable origin baked into the signed URL host (never a
    // docker-internal alias). Credentials come from env — never hardcoded/logged.
    s3: {
      endpoint: str('ATTACHMENT_S3_ENDPOINT', 'http://localhost:9000'),
      region: str('ATTACHMENT_S3_REGION', 'us-east-1'),
      accessKeyId: str('ATTACHMENT_S3_ACCESS_KEY', ''),
      secretAccessKey: str('ATTACHMENT_S3_SECRET_KEY', ''),
      forcePathStyle: true,
    },
    // Secret keying the HMAC signature over (objectKey + expiry). Dev fallback;
    // MUST be overridden in production (enforced via requireSafeSigningSecret).
    signingSecret: requireSafeSigningSecret(str('ATTACHMENT_SIGNING_SECRET', DEV_SIGNING_SECRET)),
    // TTL for presigned PUT (upload) URLs.
    uploadUrlTtlSeconds: num('ATTACHMENT_UPLOAD_URL_TTL_SECONDS', 300),
    // TTL for re-issued signed GET (read) URLs (§3.5 step 5).
    readUrlTtlSeconds: num('ATTACHMENT_READ_URL_TTL_SECONDS', 600),
    // Size caps are tiered by MIME (§3.5). The tier is chosen by the backend
    // from the 'image/' prefix — never trusted from the client — and both tiers
    // hard-cap. The split exists because images render inline (kept small for
    // collab/load), while pdf/office/zip files are routinely larger.
    maxImageSizeBytes: num('ATTACHMENT_MAX_IMAGE_SIZE_BYTES', 10 * 1024 * 1024),
    maxFileSizeBytes: num('ATTACHMENT_MAX_FILE_SIZE_BYTES', 50 * 1024 * 1024),
    // Comma-separated allowed MIME list. An entry ending in '/' is a PREFIX
    // match (e.g. 'image/' matches image/png); an entry without a trailing
    // slash is an EXACT match (e.g. 'text/plain' must equal the base mime, so
    // forged 'text/plaintext' is rejected — see attachments.ts:mimeAllowed).
    allowedMimePrefixes: str(
      'ATTACHMENT_ALLOWED_MIME_PREFIXES',
      [
        'image/',
        'application/pdf',
        'text/plain',
        'application/zip',
        'application/x-zip-compressed',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ].join(','),
    ),
    // Comma-separated MIME denylist that takes precedence over the allowed list.
    // SVG is an XML document that can carry inline <script>, so even though it
    // matches the 'image/' prefix it is an XSS vector when served from our
    // origin. The rest are HTML/script/executable types that must never be
    // served inline from our origin even if declared as an allowed type (§3.5).
    blockedMimes: str(
      'ATTACHMENT_BLOCKED_MIMES',
      [
        'image/svg+xml',
        'text/html',
        'application/xhtml+xml',
        'application/x-msdownload',
        'application/x-msdos-program',
        'application/x-executable',
        'application/vnd.microsoft.portable-executable',
        'application/x-sh',
        'application/x-csh',
        'text/javascript',
        'application/javascript',
        'application/x-httpd-php',
        'application/java-archive',
      ].join(','),
    ),
  },

  // §3.5 (⑰) link-card OG fetch. All outbound fetching is SSRF-guarded; these
  // bound the request (timeout/size) and the result cache. UA is fixed so target
  // sites can identify the bot.
  og: {
    fetchTimeoutMs: num('OG_FETCH_TIMEOUT_MS', 5000),
    maxResponseBytes: num('OG_MAX_RESPONSE_BYTES', 512 * 1024),
    maxRedirects: num('OG_MAX_REDIRECTS', 3),
    userAgent: str('OG_USER_AGENT', 'octo-docs-linkcard/1.0 (+bot)'),
    // Comma-separated port allowlist; anything else is treated as ssrf_blocked.
    allowedPorts: str('OG_ALLOWED_PORTS', '80,443'),
    cacheSuccessTtlSeconds: num('OG_CACHE_SUCCESS_TTL_SECONDS', 24 * 60 * 60),
    cacheFailureTtlSeconds: num('OG_CACHE_FAILURE_TTL_SECONDS', 300),
  },

  // §9.5 single-document Yjs state hard cap.
  maxDocBytes: num('MAX_DOC_BYTES', 10 * 1024 * 1024),
} as const
