import { useEffect, useRef } from 'react'

const REFRESH_EVENT = 'plannen:refresh'

/**
 * Ask every mounted view to reload its data. Backs the header refresh button —
 * useful in the installed PWA, which has no browser reload.
 */
export function requestRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT))
}

/**
 * Run `reload` when the app should refresh its data:
 *  - on an explicit requestRefresh() (the header button), and
 *  - when the tab/PWA regains visibility or focus,
 * so events added by another medium (e.g. via Claude) appear without a
 * close/reopen. Bursts within 1s are coalesced so focus + visibilitychange
 * don't double-fire.
 */
export function useAppRefresh(reload: () => void): void {
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const lastRef = useRef(0)

  useEffect(() => {
    const fire = () => {
      const now = Date.now()
      if (now - lastRef.current < 1000) return
      lastRef.current = now
      reloadRef.current()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') fire() }
    window.addEventListener(REFRESH_EVENT, fire)
    window.addEventListener('focus', fire)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener(REFRESH_EVENT, fire)
      window.removeEventListener('focus', fire)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
