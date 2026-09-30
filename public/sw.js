// 홈 화면 추가(PWA)용 서비스 워커: 앱 껍데기와 단어 세트만 캐시, 나머지 API는 항상 네트워크
const CACHE = 'voca800-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/css/student.css', '/js/common.js', '/js/student.js', '/shared/scoring.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isSet = /^\/api\/stages\//.test(url.pathname);
  if (url.pathname.startsWith('/api/') && !isSet) return;
  // 네트워크 우선, 실패 시 캐시(오프라인에서도 앱과 이미 받은 세트는 열림)
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && (isSet || SHELL.includes(url.pathname))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
