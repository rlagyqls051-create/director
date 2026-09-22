const CACHE = 'offcut-director-v2';
const ASSETS = ['.', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-512.png', 'icon-180.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// stale-while-revalidate: 캐시로 즉시 응답 + 백그라운드에서 갱신 → 다음 실행부터 새 버전
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(r => {
    const net = fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then(cc => cc.put(e.request, c)); }
      return res;
    }).catch(() => r);
    return r || net;
  }));
});
