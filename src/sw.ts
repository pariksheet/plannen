/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

// Minimal SW: precache the build for installability + handle push events.
// We intentionally do NOT register runtime caching strategies for navigations
// or API responses — those caused intermittent "stuck loading" symptoms when a
// stale precached shell pointed at chunk hashes from a previous deploy. The
// browser's normal network behaviour is good enough for navigations and for
// the (cross-origin) Supabase calls on Tier 1/2.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Take over open pages as soon as the new SW activates so chunk-hash drift
// from a stale precache can't cause 404s on the next navigation.
self.addEventListener('install', () => {
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

interface PushPayload {
  title?: string
  body?: string
  url?: string
  tag?: string
}

self.addEventListener('push', (event) => {
  const data: PushPayload = (() => {
    try {
      return event.data?.json() ?? {}
    } catch {
      return { title: 'Plannen', body: event.data?.text() ?? '' }
    }
  })()
  const title = data.title ?? 'Plannen'
  const body = data.body ?? ''
  const url = data.url ?? '/dashboard'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
      tag: data.tag ?? 'plannen',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/dashboard'
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window' })
      for (const client of clientsList) {
        if ('focus' in client) {
          await (client as WindowClient).navigate(url).catch(() => null)
          return (client as WindowClient).focus()
        }
      }
      return self.clients.openWindow(url)
    })(),
  )
})

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
