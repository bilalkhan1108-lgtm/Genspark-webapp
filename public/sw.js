// Service Worker — ADITION ELECTRIC SOLUTION v39
// Strategy: Cache-first for static UI · Network-first w/ cache fallback for API
// v39: Full offline app shell, API response caching, image caching for offline viewing
const CACHE_VER   = 'aes-v39';
const API_CACHE   = 'aes-api-v39';
const IMG_CACHE   = 'aes-img-v39';

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
      Promise.all(keys.filter(k => k !== CACHE_VER && k !== API_CACHE && k !== IMG_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: smart routing ──────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle GET requests for caching (POST/PUT/DELETE are write ops)
  if (request.method !== 'GET') return;

  // 1. API image endpoints → cache aggressively for offline viewing
  if (url.pathname.startsWith('/api/images/')) {
    e.respondWith(
      caches.open(IMG_CACHE).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const resp = await fetch(request);
          if (resp.ok) cache.put(request, resp.clone());
          return resp;
        } catch {
          return cached || new Response('', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // 2. API read endpoints → network-first, cache fallback for offline
  //    Cache GET /api/jobs, /api/jobs/:id, /api/analytics, /api/staff, /api/settings
  if (url.pathname.startsWith('/api/')) {
    const cacheable = /^\/(api\/jobs|api\/analytics|api\/staff|api\/settings|api\/health)/.test(url.pathname);
    if (cacheable) {
      e.respondWith(
        caches.open(API_CACHE).then(async cache => {
          try {
            const resp = await fetch(request);
            if (resp.ok) cache.put(request, resp.clone());
            return resp;
          } catch {
            const cached = await cache.match(request);
            if (cached) return cached;
            return new Response(JSON.stringify({ error: 'Offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        })
      );
    }
    // Non-cacheable API calls (POST, mutations) — let them pass through
    return;
  }

  // 3. CDN resources (tailwind, fontawesome, etc.) → stale-while-revalidate
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

  // 4. Local static assets → cache-first, background revalidate
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
      // v39: If no cache and offline, serve the root page (app shell)
      // This ensures the PWA always opens, even for deep links like /track?job=X
      const result = await fetchPromise;
      if (result) return result;
      const rootCached = await cache.match('/');
      return rootCached || new Response('Offline — please reconnect', { status: 503 });
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

// ── v39: Periodic cache cleanup — keep image cache under 100MB ───────────────
async function trimImageCache() {
  const cache = await caches.open(IMG_CACHE);
  const keys = await cache.keys();
  // Keep last 500 images max — delete oldest
  if (keys.length > 500) {
    const toDelete = keys.slice(0, keys.length - 500);
    for (const req of toDelete) await cache.delete(req);
  }
}
// Run cleanup on activate
self.addEventListener('activate', e => {
  e.waitUntil(trimImageCache());
});
