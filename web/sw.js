/*
 * The remote client's service worker.
 *
 * Its only job is to make the app installable and to open instantly on a phone.
 * It therefore caches *static app assets* and nothing else: every `/api/` request
 * carries session data and a device token, and a cached copy of either would be
 * served to the next person who unlocks the phone. API traffic is passed straight
 * through, and navigation falls back to the cached shell only when the host is
 * unreachable.
 */

const CACHE = 'gajae-remote-v1'
const SHELL = '/'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, '/manifest.webmanifest']))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  )
})

function isStaticAsset(url) {
  return /\.(?:js|css|png|jpg|jpeg|svg|webp|gif|ico|woff2?|webmanifest)$/u.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Live session and auth data are never cached, not even for a moment.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put(SHELL, copy))
          }
          return response
        })
        .catch(() =>
          caches
            .match(SHELL)
            .then((cached) => cached ?? Response.error()),
        ),
    )
    return
  }

  if (!isStaticAsset(url)) return
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
