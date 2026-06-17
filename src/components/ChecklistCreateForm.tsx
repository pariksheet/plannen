import { useMemo, useState } from 'react'
import { Modal } from './Modal'
import type { Event } from '../types/event'
import type { NewChecklistItem } from '../services/checklistService'

interface Props {
  /** Events the checklist can attach to (any event the user owns). */
  events: Event[]
  onCreate: (input: { title: string; event_id: string | null; items: NewChecklistItem[] }) => Promise<void> | void
  onClose: () => void
  /** Pre-select an event (e.g. when launched from that event's detail). */
  defaultEventId?: string | null
}

/**
 * Create a checklist — title, an optional event to attach it to (searchable
 * over all your events), and optional starter items. Each item is added as a
 * checkbox row (the same as the live checklist) and can be pre-checked if it's
 * already done. Picking an event sets the checklist's event_id.
 */
export function ChecklistCreateForm({ events, onCreate, onClose, defaultEventId = null }: Props) {
  const [title, setTitle] = useState('')
  const [eventId, setEventId] = useState<string | null>(defaultEventId)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<{ text: string; checked: boolean }[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const selected = events.find((e) => e.id === eventId) ?? null
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Cancelled events aren't valid attach targets — hide them from the picker.
    const attachable = events.filter((e) => e.event_status !== 'cancelled')
    const matches = q ? attachable.filter((e) => e.title.toLowerCase().includes(q)) : attachable
    return matches.slice(0, 30)
  }, [events, query])

  const addDraft = () => {
    const t = draft.trim()
    if (!t) return
    setItems((xs) => [...xs, { text: t, checked: false }])
    setDraft('')
  }
  const toggleAt = (i: number) => setItems((xs) => xs.map((x, idx) => (idx === i ? { ...x, checked: !x.checked } : x)))
  const removeAt = (i: number) => setItems((xs) => xs.filter((_, idx) => idx !== i))

  const submit = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onCreate({ title: t, event_id: eventId, items })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
          <label className="block text-sm font-medium text-gray-700 mb-1">Attach to event (optional)</label>
          {selected ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center text-sm bg-violet-50 text-violet-700 border border-violet-100 rounded-lg px-2 py-1 max-w-full truncate" title={selected.title}>
                {selected.title}
              </span>
              <button type="button" onClick={() => { setEventId(null); setQuery('') }} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          ) : (
            <div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your events…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
              {query.trim() && (
                <ul className="mt-1 max-h-44 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                  {filtered.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-gray-400">No matching events</li>
                  ) : filtered.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => { setEventId(e.id); setQuery('') }}
                        className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        <span className="truncate">{e.title}</span>
                        <span className="ml-auto text-xs text-gray-400 whitespace-nowrap">{fmtDate(e.start_date)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Items (optional)</label>
          {items.length > 0 && (
            <ul className="space-y-1 mb-2">
              {items.map((it, i) => (
                <li key={i} className="flex items-center gap-2 min-h-[40px]">
                  <input
                    type="checkbox"
                    className="h-5 w-5 flex-shrink-0"
                    checked={it.checked}
                    onChange={() => toggleAt(i)}
                    aria-label={it.checked ? `Uncheck ${it.text}` : `Check ${it.text}`}
                  />
                  <span className={`flex-1 text-sm ${it.checked ? 'line-through text-gray-400' : 'text-gray-900'}`}>{it.text}</span>
                  <button type="button" onClick={() => removeAt(i)} aria-label={`Remove ${it.text}`} className="text-gray-300 hover:text-red-500 px-1">×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDraft() } }}
              placeholder="Add an item…"
              className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2.5 text-sm min-h-[44px]"
            />
            <button type="button" onClick={addDraft} disabled={!draft.trim()} className="shrink-0 min-h-[44px] px-4 py-2.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">Add</button>
          </div>
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
