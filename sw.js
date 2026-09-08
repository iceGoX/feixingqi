const CACHE = 'feixingqi-dev-v1';
const FILES = ['./','./index.html','./styles.css','./game.js','./shared/board.js','./shared/engine.js','./shared/motion.js','./assets/lobby-hero.webp','./assets/planes-q-atlas.jpg'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('feixingqi-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && url.pathname.startsWith(new URL('./', self.location).pathname)) { const saved = response.clone(); void caches.open(CACHE).then(cache => cache.put(event.request, saved)); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match(new URL('./index.html', self.location)) : Response.error())));
});
