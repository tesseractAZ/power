/**
 * URL helpers for the Power SPA (v0.9.5).
 *
 * Direct LAN access:    http://homeassistant.local:8787/
 * HA Ingress (sidebar): http://homeassistant.local:8123/api/hassio_ingress/<token>/
 *
 * Both must work. The trick: ALWAYS construct URLs relative to whatever
 * directory the SPA was loaded from. Absolute `/api/...` paths break
 * under HA Ingress because they'd skip the `/api/hassio_ingress/<token>`
 * prefix HA's reverse-proxy needs.
 *
 * `apiUrl('api/snapshot')` returns:
 *   - Direct LAN:    "/api/snapshot"
 *   - HA Ingress:    "/api/hassio_ingress/<token>/api/snapshot"
 *
 * `wsUrl()` returns a WebSocket URL targeting the same `/ws` endpoint
 * under whatever path the SPA is mounted at. HA Ingress proxies WS too.
 */

/** Directory the SPA was served from, with trailing slash. */
function baseDir(): string {
  if (typeof window === 'undefined') return '/';
  const p = window.location.pathname;
  if (p.endsWith('/')) return p;
  // Strip everything after the last slash (e.g. /api/hassio_ingress/X/foo.html → /api/hassio_ingress/X/)
  return p.replace(/\/[^/]*$/, '/') || '/';
}

/**
 * Build a URL relative to the SPA root.
 * Pass paths WITHOUT a leading slash, e.g. apiUrl('api/snapshot').
 * Leading slashes are stripped if present so existing call sites can
 * be sed-converted with minimal effort.
 */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path.slice(1) : path;
  return baseDir() + p;
}

/** WebSocket URL targeting `${baseDir}ws`. */
export function wsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/ws';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${baseDir()}ws`;
}
