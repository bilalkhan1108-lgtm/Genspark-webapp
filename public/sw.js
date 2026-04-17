// Service Worker — ADITION ELECTRIC SOLUTION v37
// Strategy: Cache-first for static UI · Network-first for API · Offline memory via IndexedDB
const CACHE_VER  = 'aes-v37';
const STATIC_URLS = [
  '/',
  '/static/app.js',
  '/static/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: pre-cache all static assets ─────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VER).then(cache => cache.addAll(STATIC_URLS))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: smart routing ──────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. API calls → network-only (IndexedDB handles offline data in the app)
  if (url.pathname.startsWith('/api/')) return;

  // 2. CDN resources (tailwind, fontawesome, etc.) → stale-while-revalidate
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.open(CACHE_VER).then(async cache => {
        const cached = await cache.match(request);
        const fetchPromise = fetch(request).then(resp => {
          if (resp.ok) cache.put(request, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // 3. Local static assets → cache-first, background revalidate
  e.respondWith(
    caches.open(CACHE_VER).then(async cache => {
      const cached = await cache.match(request);
      const fetchPromise = fetch(request).then(resp => {
        if (resp.ok) cache.put(request, resp.clone());
        return resp;
      }).catch(() => null);
      if (cached) {
        fetchPromise.catch(() => {});
        return cached;
      }
      return fetchPromise || new Response('Offline', { status: 503 });
    })
  );
});

// ── Background sync: reload data when back online ────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-jobs') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SYNC_JOBS' }))
      )
    );
  }
});
