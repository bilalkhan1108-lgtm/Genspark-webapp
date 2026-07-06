// Service Worker — ADITION ELECTRIC SOLUTION v49
// Strategy: Cache-first for static UI · Network-first w/ cache fallback for API
// v49: Critical crash fix, global error guard, all v48 features
const CACHE_VER   = 'aes-v52-5';
const API_CACHE   = 'aes-api-v52-5';
const IMG_CACHE   = 'aes-img-v52-5';

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
    ).then(() => trimImageCache())
  );
  self.clients.claim();
});

// ── Fetch: smart routing ──────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle GET requests for caching
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
  //    v48: Also cache /api/customers/history and /api/reports for offline ledger
  if (url.pathname.startsWith('/api/')) {
    const cacheable = /^\/(api\/jobs|api\/analytics|api\/staff|api\/settings|api\/health|api\/customers)/.test(url.pathname);
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

// ── Periodic cache cleanup — keep image cache under 500 items ────────────────
async function trimImageCache() {
  try {
    const cache = await caches.open(IMG_CACHE);
    const keys = await cache.keys();
    if (keys.length > 500) {
      const toDelete = keys.slice(0, keys.length - 500);
      for (const req of toDelete) await cache.delete(req);
    }
  } catch {}
}
