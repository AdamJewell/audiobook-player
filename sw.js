// Caches the app so it opens offline. Serves from cache first and refreshes the
// cache in the background, so an update shows up on the next launch.

var CACHE = 'audiobooks-v1';
var FILES = ['./', 'index.html', 'app.js', 'chapters.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      if (hit) {
        e.waitUntil(fresh.catch(function () {}));
        return hit;
      }
      return fresh;
    });
  }));
});
