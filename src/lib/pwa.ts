import { registerSW } from 'virtual:pwa-register'

export function registerPWA(): void {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  registerSW({
    immediate: true,
    onNeedRefresh() {
      // Silent auto-update on next page load.
    },
    onOfflineReady() {
      // no-op
    },
  })
}
