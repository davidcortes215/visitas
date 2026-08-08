// Service worker: permite abrir la app aunque no haya conexión.
// Estrategia "red primero": siempre intenta traer la versión actual y, si
// no hay internet, tira de la copia en caché.
const CACHE = 'visitas-v9';
const ASSETS = [
  './',
  'index.html',
  'styles.css?v=9',
  'app.js?v=9',
  'manifest.json',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Las llamadas a la API nunca se cachean
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
