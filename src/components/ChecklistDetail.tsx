import { useState } from 'react'
import { useChecklist } from '../hooks/useChecklist'
import { ChecklistItemRow } from './ChecklistItemRow'

export function ChecklistDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { checklist, toggle, addItems, removeItem } = useChecklist(id)
  const [draft, setDraft] = useState('')
  if (!checklist) return <div className="py-12 text-center text-gray-400">Loading…</div>
  const submit = async () => {
    const texts = draft.split('\n').map((t) => t.trim()).filter(Boolean)
    if (texts.length) { await addItems(texts); setDraft('') }
  }
  return (
    <div className="w-full max-w-2xl mx-auto">
      <button type="button" onClick={onBack} className="text-sm text-indigo-600 mb-3">← Back</button>
      <h2 className="text-lg font-semibold text-gray-900 mb-3">{checklist.title}</h2>
      <ul className="space-y-1">
        {checklist.items?.map((it) => (
          <ChecklistItemRow key={it.id} item={it} onToggle={toggle} onDelete={removeItem} />
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="Add an item…" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <button type="button" onClick={() => void submit()} className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm">Add</button>
      </div>
    </div>
  )
}
