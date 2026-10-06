// sw.js — makes the page installable as an app. It stores nothing itself.
// Every file of the app is checked with GitHub on every launch (a quick "not modified"
// when nothing changed), so the phone never runs a mix of old and new files.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // By address, not by the request object: a page-navigation request cannot be copied with options.
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
});
