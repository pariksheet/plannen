import { useState } from 'react'
import { Modal } from './Modal'
import { format } from 'date-fns'

interface MatchRow {
  id: string
  title: string
  start_date: string
}

interface Props {
  isOpen: boolean
  matches: MatchRow[]
  onClose: () => void
  onDelete: (ids: string[]) => void | Promise<void>
}

export function SweepMatchesDialog({ isOpen, matches, onClose, onDelete }: Props) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(matches.map((m) => m.id)))

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function handleDelete() {
    const ids = matches.map((m) => m.id).filter((id) => checked.has(id))
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete(ids)
      onClose()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete one or more events')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`This rule also matches ${matches.length} other event${matches.length === 1 ? '' : 's'}`}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">Delete the ones you don't want to keep:</p>
        <ul className="space-y-2 max-h-[40vh] overflow-y-auto">
          {matches.map((m) => (
            <li key={m.id} className="flex items-center gap-2 p-2 rounded-md border border-gray-200">
              <input
                type="checkbox"
                checked={checked.has(m.id)}
                onChange={() => toggle(m.id)}
                aria-label={`Delete ${m.title}`}
              />
              <span className="flex-1 text-sm">{m.title}</span>
              <span className="text-xs text-gray-500">{format(new Date(m.start_date), 'MMM d, yyyy')}</span>
            </li>
          ))}
        </ul>
        {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={deleting} className="min-h-[44px] px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md disabled:opacity-50">
            Keep all
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="min-h-[44px] px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete selected'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
