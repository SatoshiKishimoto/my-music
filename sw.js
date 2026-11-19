// アプリ本体はネットワーク優先（更新をすぐ反映）。オフライン時はキャッシュで動かす。
// 曲・動画のデータは IndexedDB に保存されているので、オフラインでも再生できる。
const CACHE = 'my-music-app-v14';
const APP = ['./', './index.html', './style.css', './app.js', './extract.js', './mp3-worker.js', './vendor/lame.min.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP.map(p => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  if (!APP.some(p => new URL(p, self.registration.scope).pathname === u.pathname)) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
