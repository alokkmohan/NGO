// Service Worker for Samagra UP NGO Partner Portal
const CACHE_NAME = 'samagra-ngo-v3';
const ASSETS_TO_CACHE = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Caching app shell assets');
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('[ServiceWorker] Cache addAll warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Pass-through Google Apps Script API calls directly to network
  if (event.request.url.includes('script.google.com')) {
    return;
  }

  // Network-first for page navigations and same-origin files (index.html,
  // manifest.json, etc.) so a new deploy shows up on the very next load
  // instead of being stuck behind whatever got cached first. Falls back to
  // cache only when offline.
  const isSameOrigin = new URL(event.request.url).origin === self.location.origin;
  if (event.request.mode === 'navigate' || isSameOrigin) {
    event.respondWith(
      fetch(event.request).then((fetchRes) => {
        return caches.open(CACHE_NAME).then((cache) => {
          if (event.request.method === 'GET') cache.put(event.request, fetchRes.clone());
          return fetchRes;
        });
      }).catch(() => caches.match(event.request).then((cached) => {
        return cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined);
      }))
    );
    return;
  }

  // Cache-first for cross-origin CDN assets (rarely change, safe to cache)
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request).then((fetchRes) => {
        return caches.open(CACHE_NAME).then((cache) => {
          if (event.request.method === 'GET') cache.put(event.request, fetchRes.clone());
          return fetchRes;
        });
      });
    })
  );
});
