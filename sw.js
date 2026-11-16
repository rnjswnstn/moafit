// MOAFIT 서비스 워커: 앱 껍데기는 캐시, 상품 데이터는 항상 최신을 먼저 시도
const VER = 'moafit-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const font = url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com';
  if (url.origin !== location.origin && !font) return; // 상품 사진 등 외부 자원은 브라우저에 맡김
  if (font) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(VER).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  // 같은 출처: 네트워크 우선, 실패하면 캐시(오프라인에서도 마지막 카탈로그가 보임)
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VER).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
