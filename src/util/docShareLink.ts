/**
 * Canonical doc share-link builder.
 *
 * This is the SINGLE place the backend mints the browser-facing URL a caller
 * (a bot via octo-cli, the OpenClaw octo plugin, or any integration) can pass
 * straight through to chat. It mirrors octo-web's authoritative `buildDocLink`
 * (packages/docs/src/forward/link.ts) byte-for-byte for the same (docId,
 * spaceId), so a link minted here and one minted by a human's "forward to chat"
 * are identical.
 *
 * Canonical format:
 *   <web-origin>/d/<docId>?sp=<spaceId>
 *
 *   - The path carries the docId (NOT a `/docs?doc=` query — the octo host's
 *     RouteManager strips the query, which is what produced the broken links).
 *   - `?sp=<spaceId>` is the doc's real space id so the recipient's
 *     `GET /docs/{docId}` preflight addresses the doc's own space. Omitted when
 *     no spaceId is available.
 *   - NEVER emit `?sid`.
 *
 * When `webOrigin` is empty the URL degrades to a path-only, origin-relative
 * form (`/d/<docId>?sp=<spaceId>`) — mirroring octo-web's origin()-empty
 * degrade — rather than baking in a wrong absolute host.
 */
export function buildDocShareUrl(webOrigin: string, docId: string, spaceId?: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, '')
  const path = `${origin}/d/${encodeURIComponent(docId)}`
  return spaceId ? `${path}?sp=${encodeURIComponent(spaceId)}` : path
}
