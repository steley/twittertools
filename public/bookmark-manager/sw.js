/*
 * Bookmark Manager PWA service worker.
 *
 * Scope: /bookmark-manager/ ONLY (the file lives inside that directory).
 * Other pages of the site are never controlled by this worker.
 *
 * Strategies:
 *   - page shell (navigations to /bookmark-manager): network-first, cached
 *     fallback — online you always get the newest version, offline the last
 *     one still opens;
 *   - hashed static bundles (/_astro/…): stale-while-revalidate;
 *   - proxied media (/api/download): cache-first with a 7-day TTL and an
 *     entry cap, so images already seen keep working offline;
 *   - API JSON (/api/tweet, /api/thread, …): NEVER cached — bookmark data
 *     lives in IndexedDB, and fetches are per-need anyway.
 *
 * Bump CACHE_VERSION to invalidate every cache on the next load.
 */
const CACHE_VERSION = 'v2';
const SHELL = `bm-shell-${CACHE_VERSION}`;
const MEDIA = `bm-media-${CACHE_VERSION}`;
const MEDIA_TTL = 7 * 24 * 60 * 60 * 1000; // matches the origin's 7-day header
const MEDIA_MAX_ENTRIES = 150;

self.addEventListener('install', () => {
  // nothing to precache — the shell fills on first navigation
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // CacheStorage is scoped to the ORIGIN, not to this worker's scope —
      // only touch caches this worker owns (the bm- prefix), never another
      // worker's or page's caches.
      for (const name of await caches.keys()) {
        if (name.startsWith('bm-') && name !== SHELL && name !== MEDIA) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: hands off

  // Path boundary helpers — startsWith alone would also match sibling paths
  // like /api/downloads or /bookmark-manager-admin.
  const isDownload = url.pathname === '/api/download' || url.pathname.startsWith('/api/download?');
  const inBookmarkApp = url.pathname === '/bookmark-manager' || url.pathname.startsWith('/bookmark-manager/');

  // API JSON — never cached
  if (url.pathname.startsWith('/api/') && !isDownload) return;

  // proxied media — cache-first, TTL, capped
  if (isDownload) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(MEDIA);
        const hit = await cache.match(req);
        if (hit && Date.now() - Number(hit.headers.get('sw-cached-at') || 0) < MEDIA_TTL) {
          return hit;
        }
        if (hit) await cache.delete(req);
        try {
          const res = await fetch(req);
          if (res.status === 200) {
            const headers = new Headers(res.headers);
            headers.set('sw-cached-at', String(Date.now()));
            const stamped = new Response(await res.clone().blob(), {
              status: 200,
              statusText: res.statusText,
              headers,
            });
            await cache.put(req, stamped);
            // eviction runs after respondWith resolves — tie it to the event
            // so the worker isn't killed mid-trim
            event.waitUntil(trimMedia(cache));
          }
          return res;
        } catch {
          return hit || Response.error(); // expired entry beats nothing offline
        }
      })()
    );
    return;
  }

  // app shell navigation — network-first, offline fallback
  if (req.mode === 'navigate' && inBookmarkApp) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        try {
          const res = await fetch(req);
          if (res.ok) await cache.put(req, res.clone());
          return res;
        } catch {
          const hit = await cache.match(req);
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // hashed static bundles — stale-while-revalidate
  if (url.pathname.startsWith('/_astro/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const hit = await cache.match(req);
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => undefined);
        event.waitUntil(refresh); // keep the revalidation alive past respondWith
        return hit || (await refresh) || Response.error();
      })()
    );
  }
});

async function trimMedia(cache) {
  const keys = await cache.keys();
  if (keys.length <= MEDIA_MAX_ENTRIES) return;
  const entries = await Promise.all(
    keys.map(async (k) => ({
      k,
      ts: Number((await cache.match(k))?.headers.get('sw-cached-at') || 0),
    }))
  );
  entries.sort((a, b) => a.ts - b.ts);
  for (const { k } of entries.slice(0, keys.length - MEDIA_MAX_ENTRIES)) {
    await cache.delete(k);
  }
}
