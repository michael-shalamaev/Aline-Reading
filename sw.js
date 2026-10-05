// sw.js — makes the page installable as an app. It caches nothing on purpose:
// every launch loads the latest version, and every request goes to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network as usual */ });
