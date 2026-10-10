const CACHE = "lita-demo-1.0.0-06c2b3d";

const SHELL = [ "./portal.html", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png" ];

self.addEventListener("install", event => {
 event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
 event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
 if (event.request.method !== "GET") return;
 event.respondWith(fetch(event.request).then(res => {
  var resClone = res.clone();
  caches.open(CACHE).then(cache => cache.put(event.request, resClone));
  return res;
 }).catch(() => caches.match(event.request)));
});