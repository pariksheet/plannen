import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Modal } from './Modal'
import { useSettings } from '../context/SettingsContext'
import { EventDiscoveryForm, type EventDiscoveryFormHandle } from './EventDiscoveryForm'
import type { EventFormData } from '../types/event'

interface DiscoverButtonProps {
  /** Called when a discovery result is picked. Owner opens the create-event flow. */
  onStartCreateWithData: (data: EventFormData) => void
  /** Called when a result is created via the inline path (rare). */
  onEventCreated?: () => void
}

/**
 * Compact entry point for the AI-powered Discover feature. Replaces the
 * inline EventDiscoveryForm in the feed header.
 *
 * - With an AI key configured: opens a modal with the existing
 *   EventDiscoveryForm.
 * - Without one: opens the same modal but with a CTA pointing at AI Settings,
 *   so the affordance is always visible.
 */
export function DiscoverButton({ onStartCreateWithData, onEventCreated }: DiscoverButtonProps) {
  const { hasAiKey } = useSettings()
  const [open, setOpen] = useState(false)
  const formRef = useRef<EventDiscoveryFormHandle>(null)

  const handleClose = () => {
    setOpen(false)
    // Reset the form so reopening starts fresh.
    formRef.current?.resetDiscovery()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={hasAiKey ? 'Discover events with AI' : 'AI key not set — add one to use Discover'}
        aria-label="Discover events with AI"
        className="relative inline-flex items-center min-h-[44px] py-2.5 px-3 sm:px-4 border border-indigo-200 bg-white text-indigo-700 font-medium rounded-md hover:bg-indigo-50 text-sm sm:text-base justify-center"
      >
        <Sparkles className="h-5 w-5 sm:mr-2" />
        <span className="hidden sm:inline">Discover</span>
        {!hasAiKey && (
          <span
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400"
            aria-label="AI key not configured"
          />
        )}
      </button>

      {open && (
        <Modal isOpen onClose={handleClose} title="Discover events with AI">
          {!hasAiKey ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Discover uses your own Anthropic API key to search the web for relevant events. You haven&apos;t added one yet.
              </p>
              <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
                Open <span className="font-medium">AI Settings</span> and paste your Anthropic API key — it&apos;s stored only in your Plannen account and is never shared.
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <Link
                  to="/dashboard?view=settings"
                  onClick={handleClose}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
                >
                  Open AI Settings
                </Link>
              </div>
            </div>
          ) : (
            <EventDiscoveryForm
              ref={formRef}
              onEventCreated={() => {
                onEventCreated?.()
                handleClose()
              }}
              onStartCreateWithData={(data) => {
                onStartCreateWithData(data)
                handleClose()
              }}
            />
          )}
        </Modal>
      )}
    </>
  )
}
