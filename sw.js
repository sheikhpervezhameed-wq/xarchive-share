// X Archive phone app: works offline (the page is kept on the phone), and sends waiting shares by itself
// when the phone is back online (Background Sync, in Chrome on Android).
importScripts('send.js');
const CACHE = 'xa-phone-v2';     // 0.9.5: search added
const FILES = ['./', './index.html', './send.js', './phone-search.js', './phone-embed.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;          // GitHub's API is never cached
  // The page itself (with or without a share in its address): the network first, the kept copy when offline.
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); if (r.ok && !u.search) caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(u.pathname.endsWith('/') ? './' : e.request, { ignoreSearch: true })));
});
self.addEventListener('sync', (e) => { if (e.tag === 'xa-send') e.waitUntil(self.XA.sendWaiting().then((r) => { if (r.retry) throw new Error('retry later'); })); });
