import { useState } from 'react'
import { ListChecks, Plus } from 'lucide-react'
import { useChecklists } from '../hooks/useChecklists'
import { ChecklistDetail } from './ChecklistDetail'
import { ChecklistCreateForm } from './ChecklistCreateForm'
import { Modal } from './Modal'
import type { Event } from '../types/event'

/**
 * Checklists attached to a single event, shown on the event detail. Lists the
 * event's checklists (with done/total), opens one in a modal, and creates a new
 * checklist pre-attached to this event.
 */
export function EventChecklists({ event }: { event: Event }) {
  const { checklists, create, reload } = useChecklists(event.id)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  return (
    <div className="border-t border-gray-100 pt-3 mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          <ListChecks className="h-4 w-4 text-indigo-500" /> Checklists
        </span>
        <button type="button" onClick={() => setShowForm(true)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800">
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      </div>
      {checklists.length === 0 ? (
        <p className="text-xs text-gray-400">No checklists for this event yet.</p>
      ) : (
        <ul className="space-y-1">
          {checklists.map((cl) => {
            const total = cl.total ?? 0
            const done = cl.done ?? 0
            return (
              <li key={cl.id}>
                <button type="button" onClick={() => setOpenId(cl.id)} className="flex items-center gap-2 w-full text-left text-sm text-gray-700 rounded px-1.5 py-1 hover:bg-gray-50">
                  <ListChecks className="h-3.5 w-3.5 text-indigo-500 shrink-0" aria-hidden />
                  <span className="truncate">{cl.title}</span>
                  <span className="ml-auto text-xs text-gray-400 tabular-nums">{done}/{total}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {openId && (
        <Modal isOpen title="Checklist" onClose={() => { setOpenId(null); void reload() }}>
          <ChecklistDetail id={openId} onBack={() => { setOpenId(null); void reload() }} />
        </Modal>
      )}
      {showForm && (
        <ChecklistCreateForm
          events={[event]}
          defaultEventId={event.id}
          onCreate={(input) => create(input)}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  )
}
