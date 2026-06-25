/**
 * Service worker for the Power PWA.
 *
 * Strategy:
 *   - API requests (`/api/*` anywhere in the path, `/ws`): NEVER cached.
 *   - The HTML document (navigation requests): NETWORK-FIRST. index.html is the
 *     only file that names the content-hashed JS/CSS bundles. If a stale copy
 *     is ever served it points at hashes the server deleted on the next build,
 *     and the page white-screens. So we always fetch the document fresh and
 *     fall back to cache only when offline.
 *   - Content-hashed static assets (JS/CSS/img/fonts): stale-while-revalidate.
 *     These are immutable — a given URL never changes content — so caching is
 *     safe and fast.
 *
 * v0.11.2 — fixes a Safari (and any-browser) white-screen after a redeploy:
 *   the previous version used stale-while-revalidate for the *document* too,
 *   so a cached old index.html survived a new build and referenced now-404
 *   bundles. Switched the document to network-first and bumped the cache name
 *   (below) so `activate` purges the stale cache wholesale.
 *
 * v0.9.5 — the API-detection regex matches `/api/` anywhere in the pathname so
 *   live data bypasses cache both on direct LAN (:8787/api/...) and under HA
 *   Ingress (/api/hassio_ingress/<token>/api/...).
 */
// Bump this string on any caching-behaviour change so `activate` deletes the
// previous cache (which may hold a poisoned, stale index.html).
const CACHE = 'ecoflow-panel-v0.11.2';

self.addEventListener('install', (event) => {
  // Take over as soon as installed — don't wait for all tabs to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Live data — bypass the SW entirely (direct LAN + Ingress, plus the WS).
  if (/\/api\//.test(url.pathname) || /\/ws$/.test(url.pathname)) return;
  // Only GETs are cacheable; writes (POST/PUT) must always hit the network.
  if (req.method !== 'GET') return;

  // The HTML document → network-first. Always get a fresh index.html so it
  // references the current asset hashes; fall back to the cached copy only
  // when the network is unreachable.
  const isDocument = req.mode === 'navigate' || req.destination === 'document';
  if (isDocument) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return response;
        })
        .catch(() => caches.open(CACHE).then((c) => c.match(req))),
    );
    return;
  }

  // Content-hashed static assets → stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((response) => {
            if (response.ok) cache.put(req, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    ),
  );
});
