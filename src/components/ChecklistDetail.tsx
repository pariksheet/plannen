import { useState } from 'react'
import { RotateCcw, Pencil, Check, X } from 'lucide-react'
import { useChecklist } from '../hooks/useChecklist'
import { useAuth } from '../context/AuthContext'
import { ChecklistItemRow } from './ChecklistItemRow'
import { displayUserLabel } from '../utils/displayName'

export function ChecklistDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { checklist, names, toggle, addItems, removeItem, renameItem, rename, resetAll } = useChecklist(id)
  const { user } = useAuth()
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  if (!checklist) return <div className="py-12 text-center text-gray-400">Loading…</div>
  const meId = user?.id ?? null
  const creator = checklist.created_by === meId ? 'you' : displayUserLabel(names[checklist.created_by] ?? { id: checklist.created_by })
  const items = checklist.items ?? []
  const hasChecked = items.some((i) => i.checked_at != null)
  const submit = async () => {
    const texts = draft.split('\n').map((t) => t.trim()).filter(Boolean)
    if (texts.length) { await addItems(texts); setDraft('') }
  }
  const onReset = async () => {
    if (!hasChecked) return
    if (!window.confirm('Uncheck every item in this checklist? The items stay; only their checked state is cleared.')) return
    await resetAll()
  }
  const startEditTitle = () => { setTitleDraft(checklist.title); setEditingTitle(true) }
  const saveTitle = async () => {
    const t = titleDraft.trim()
    setEditingTitle(false)
    if (t && t !== checklist.title) await rename(t)
  }
  return (
    <div className="w-full max-w-2xl mx-auto">
      <button type="button" onClick={onBack} className="text-sm text-indigo-600 mb-3">← Back</button>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
                aria-label="Edit checklist name"
                className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-1.5 text-lg font-semibold"
              />
              <button type="button" onClick={() => void saveTitle()} aria-label="Save name" className="p-1.5 text-gray-400 hover:text-green-600"><Check className="h-4 w-4" /></button>
              <button type="button" onClick={() => setEditingTitle(false)} aria-label="Cancel rename" className="p-1.5 text-gray-400 hover:text-gray-700"><X className="h-4 w-4" /></button>
            </div>
          ) : (
            <button type="button" onClick={startEditTitle} className="flex items-center gap-1.5 max-w-full text-left group" aria-label="Rename checklist">
              <h2 className="text-lg font-semibold text-gray-900 truncate">{checklist.title}</h2>
              <Pencil className="h-3.5 w-3.5 text-gray-300 group-hover:text-indigo-600 shrink-0" />
            </button>
          )}
          <p className="text-xs text-gray-500">Created by {creator}</p>
        </div>
        {hasChecked && (
          <button
            type="button"
            onClick={() => void onReset()}
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-200 rounded-md px-2 py-1.5 shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset all
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <ChecklistItemRow key={it.id} item={it} names={names} meId={meId} onToggle={toggle} onDelete={removeItem} onRename={renameItem} />
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="Add an item…" className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2.5 text-sm min-h-[44px]" />
        <button type="button" onClick={() => void submit()} className="shrink-0 min-h-[44px] bg-indigo-600 text-white rounded-lg px-4 py-2.5 text-sm font-medium">Add</button>
      </div>
    </div>
  )
}
