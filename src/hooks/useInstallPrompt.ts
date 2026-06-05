import { useCallback, useEffect, useState } from 'react'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type State = {
  deferred: BeforeInstallPromptEvent | null
  showIosInstructions: boolean
}

let state: State = { deferred: null, showIosInstructions: false }
const listeners = new Set<() => void>()

function setState(next: Partial<State>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault()
    setState({ deferred: e as BeforeInstallPromptEvent })
  })
  window.addEventListener('appinstalled', () => {
    setState({ deferred: null, showIosInstructions: false })
  })
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  const navWithStandalone = navigator as Navigator & { standalone?: boolean }
  return navWithStandalone.standalone === true
}

export function useInstallPrompt() {
  const [, force] = useState(0)

  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  const ios = isIos()
  const standalone = isStandalone()
  const canInstall = !standalone && (state.deferred !== null || ios)

  const promptInstall = useCallback(async () => {
    if (state.deferred) {
      try {
        await state.deferred.prompt()
        await state.deferred.userChoice
      } catch {
        // ignore
      }
      setState({ deferred: null })
      return
    }
    if (ios) {
      setState({ showIosInstructions: true })
    }
  }, [ios])

  const dismissIosInstructions = useCallback(() => {
    setState({ showIosInstructions: false })
  }, [])

  return {
    canInstall,
    isIos: ios,
    isStandalone: standalone,
    hasDeferredPrompt: state.deferred !== null,
    showIosInstructions: state.showIosInstructions,
    promptInstall,
    dismissIosInstructions,
  }
}
