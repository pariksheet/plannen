import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Modal } from './Modal'
import { AgentChat } from './AgentChat'

interface DiscoverButtonProps {
  /** Called whenever the assistant executes a write action, so the feed reloads. */
  onActionExecuted?: () => void
}

/**
 * Entry point for the web UI action agent. Repurposed from the old AI Discover
 * affordance: it now opens the scoped Plannen action assistant (AgentChat) —
 * create/edit/cancel events, add/check checklist items, log activity — in a
 * modal. Web event Discovery (agent-discover / agent-scrape) is shelved: those
 * functions stay deployed but are no longer wired to this button.
 */
export function DiscoverButton({ onActionExecuted }: DiscoverButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Ask the assistant to change your plans"
        aria-label="Open the Plannen assistant"
        className="relative inline-flex items-center min-h-[44px] py-2.5 px-3 sm:px-4 border border-indigo-200 bg-white text-indigo-700 font-medium rounded-md hover:bg-indigo-50 text-sm sm:text-base justify-center"
      >
        <Sparkles className="h-5 w-5 sm:mr-2" />
        <span className="hidden sm:inline">Assistant</span>
      </button>

      {open && (
        <Modal isOpen onClose={() => setOpen(false)} title="Plannen assistant">
          <AgentChat onExecuted={onActionExecuted} />
        </Modal>
      )}
    </>
  )
}
