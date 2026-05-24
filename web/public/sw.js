/**
 * Minimal service worker for EcoFlow Panel PWA (v0.8.0).
 *
 * Strategy:
 *   - Static assets (HTML, JS, CSS, images): stale-while-revalidate.
 *   - API requests (/api/*, /ws): NEVER cached — telemetry must be live.
 *
 * Lets the panel install as a PWA on iOS / Android / desktop and keep
 * the shell available offline, but always show live data when online.
 */
const CACHE = 'ecoflow-panel-v0.8.0';
const STATIC_ASSETS = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()),
  );
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
  const url = new URL(event.request.url);
  // Live data — bypass cache entirely.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  // Static — stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    ),
  );
});
