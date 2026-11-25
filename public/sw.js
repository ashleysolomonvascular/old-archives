// Offline-first service worker. The build step injects the precache list and version below.
const VERSION = '__VERSION__';
const CACHE = 'oa-' + VERSION;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('oa-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // never touch cross-origin
  e.respondWith(
    caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html');
      return fetch(req);
    }),
  );
});
