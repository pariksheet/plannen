import type { ChecklistRow } from '../lib/dbClient/types'

interface Props {
  checklists: ChecklistRow[]
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  /** Optional map of trip container id → title, to show an "attached trip" chip. */
  tripTitleById?: Record<string, string>
}

export function ChecklistList({ checklists, onOpen, onDelete, tripTitleById }: Props) {
  if (checklists.length === 0) {
    return <div className="text-center py-12"><p className="text-gray-500">No checklists yet.</p></div>
  }
  return (
    <div className="w-full max-w-2xl mx-auto space-y-3">
      {checklists.map((cl) => {
        const total = cl.total ?? 0; const done = cl.done ?? 0
        const pct = total ? Math.round((done / total) * 100) : 0
        return (
          <div key={cl.id} className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between gap-3">
              <button type="button" onClick={() => onOpen(cl.id)} className="flex-1 text-left font-semibold text-gray-900 truncate">{cl.title}</button>
              {cl.event_id && tripTitleById?.[cl.event_id] && (
                <span className="text-xs text-violet-700 bg-violet-50 border border-violet-100 rounded-full px-2 py-0.5 whitespace-nowrap max-w-[40%] truncate" title={tripTitleById[cl.event_id]}>
                  {tripTitleById[cl.event_id]}
                </span>
              )}
              <span className="text-xs text-gray-500 tabular-nums">{done}/{total}</span>
              <button type="button" onClick={() => onDelete(cl.id)} aria-label="Delete checklist" className="text-gray-300 hover:text-red-500">×</button>
            </div>
            <div className="mt-2 h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
