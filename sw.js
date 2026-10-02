// Service Worker mínimo · Fonda Raíz Portal Operativo · LiTa Support
// Objetivo único: cumplir el criterio de instalabilidad de Chrome/Android para PWA
// (manifest + service worker con evento fetch) -- SIN cachear agresivamente, porque
// el portal se actualiza seguido y un cache viejo podría mostrar una versión vieja
// de portal.html sin que el usuario se dé cuenta. Estrategia: network-first con
// fallback a cache solo si no hay red (para que abra algo si no hay conexión).
const CACHE = 'vk-portal-shell-v1';
const SHELL = ['./portal.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Refrescar el cache en segundo plano con la respuesta real más reciente.
        var resClone = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
