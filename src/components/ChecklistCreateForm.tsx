import { useState } from 'react'
import { Modal } from './Modal'
import type { Trip } from '../services/containerService'

interface Props {
  trips: Trip[]
  onCreate: (input: { title: string; event_id: string | null; items: string[] }) => Promise<void> | void
  onClose: () => void
  /** Pre-select a trip (e.g. when launched from a trip). */
  defaultEventId?: string | null
}

/**
 * Create a checklist — title, an optional trip to attach it to, and optional
 * starter items (one per line). Picking a trip sets the checklist's event_id so
 * it belongs to that trip container.
 */
export function ChecklistCreateForm({ trips, onCreate, onClose, defaultEventId = null }: Props) {
  const [title, setTitle] = useState('')
  const [eventId, setEventId] = useState<string | null>(defaultEventId)
  const [itemsText, setItemsText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    const items = itemsText.split('\n').map((s) => s.trim()).filter(Boolean)
    try {
      await onCreate({ title: t, event_id: eventId, items })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="New checklist">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Packing"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Attach to trip (optional)</label>
          <select
            value={eventId ?? ''}
            onChange={(e) => setEventId(e.target.value || null)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
          >
            <option value="">— None (standalone) —</option>
            {trips.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Items (optional, one per line)</label>
          <textarea
            value={itemsText}
            onChange={(e) => setItemsText(e.target.value)}
            rows={4}
            placeholder={'passport\nsunscreen\nsocks'}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 text-sm">Cancel</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!title.trim() || busy}
            className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  )
}
