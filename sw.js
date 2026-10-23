/* Duit Tracker service worker — makes the app open and work offline.
   App files: network first (so updates show up straight away when online),
   falling back to the cached copy offline.
   CDN files (jsPDF, Google Fonts): served from cache, refreshed in the
   background, so PDF export also works offline once loaded one time.
   Bump CACHE_VERSION whenever the list of app files changes. */
const CACHE_VERSION = 'duit-v1';
const APP_SHELL = [
  './',
  'index.html',
  'css/tailwind.css',
  'css/app.css',
  'js/i18n.js',
  'js/app.js',
  'manifest.webmanifest',
  'icon.svg'
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open(CACHE_VERSION).then(async cache => {
      const cached = await cache.match(req);
      const refresh = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || refresh;
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) caches.open(CACHE_VERSION).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
    );
  }
});
