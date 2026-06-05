import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useInstallPrompt } from '../hooks/useInstallPrompt'

const DISMISS_KEY = 'plannen.install_dismissed_at'
const DISMISS_DAYS = 14

function dismissedRecently(): boolean {
  try {
    const v = localStorage.getItem(DISMISS_KEY)
    if (!v) return false
    const when = Number(v)
    if (!Number.isFinite(when)) return false
    return Date.now() - when < DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export function InstallPrompt() {
  const {
    isStandalone,
    isIos,
    hasDeferredPrompt,
    showIosInstructions,
    promptInstall,
    dismissIosInstructions,
  } = useInstallPrompt()
  const [autoDismissed, setAutoDismissed] = useState(false)
  const [cooldown, setCooldown] = useState(true)

  useEffect(() => {
    setCooldown(dismissedRecently())
  }, [])

  if (isStandalone) return null

  // Chromium auto-toast: show once per (14 day) cooldown when prompt is captured
  if (hasDeferredPrompt && !cooldown && !autoDismissed) {
    return (
      <div className="fixed bottom-4 inset-x-4 z-50 rounded-lg bg-white shadow-lg border border-gray-200 p-3 flex items-center gap-3 sm:max-w-md sm:left-auto">
        <div className="flex-1 text-sm">
          <p className="font-medium text-gray-900">Install Plannen</p>
          <p className="text-gray-600">Use it like an app — faster, offline-ready, share-sheet support.</p>
        </div>
        <button
          onClick={() => {
            try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ }
            setAutoDismissed(true)
          }}
          aria-label="Dismiss install prompt"
          className="text-xs text-gray-400 hover:text-gray-700 p-1"
        >
          <X className="h-4 w-4" />
        </button>
        <button
          onClick={async () => {
            await promptInstall()
            setAutoDismissed(true)
          }}
          className="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm whitespace-nowrap"
        >
          Install
        </button>
      </div>
    )
  }

  // iOS instructions: shown either from auto-toast (first login, no cooldown)
  // or when the user explicitly hits "Install" in the nav (overrides cooldown).
  const showIosCard = showIosInstructions || (isIos && !cooldown && !autoDismissed)
  if (showIosCard) {
    return (
      <div className="fixed bottom-4 inset-x-4 z-50 rounded-lg bg-white shadow-lg border border-gray-200 p-3 flex items-start gap-3 sm:max-w-md sm:left-auto">
        <div className="flex-1 text-sm">
          <p className="font-medium text-gray-900">Add Plannen to your home screen</p>
          <p className="text-gray-600 mt-1">Tap the Share icon, then “Add to Home Screen”. iOS push requires this.</p>
        </div>
        <button
          onClick={() => {
            try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ }
            setAutoDismissed(true)
            dismissIosInstructions()
          }}
          aria-label="Dismiss install prompt"
          className="text-xs text-gray-500 px-2 py-1 hover:text-gray-700"
        >
          Got it
        </button>
      </div>
    )
  }

  return null
}
