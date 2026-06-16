import { formatDistanceToNow } from 'date-fns'
import type { ChecklistItemRow as Item } from '../lib/dbClient/types'
import type { FriendUser } from '../services/relationshipService'
import { displayUserLabel } from '../utils/displayName'

interface Props {
  item: Item
  /** Resolved user records, keyed by id, for created_by / checked_by. */
  names: Record<string, FriendUser>
  /** Current user's id — rendered as "you". */
  meId?: string | null
  onToggle: (id: string, checked: boolean) => void
  onDelete: (id: string) => void
}

function nameFor(id: string, names: Record<string, FriendUser>, meId?: string | null): string {
  if (meId && id === meId) return 'you'
  return displayUserLabel(names[id] ?? { id })
}

export function ChecklistItemRow({ item, names, meId, onToggle, onDelete }: Props) {
  const checked = item.checked_at != null
  const addedBy = item.created_by ? nameFor(item.created_by, names, meId) : null
  const checkedBy = checked && item.checked_by ? nameFor(item.checked_by, names, meId) : null
  const when = item.checked_at ? formatDistanceToNow(new Date(item.checked_at), { addSuffix: true }) : null
  const showMeta = !!addedBy || !!checkedBy
  return (
    <li className="flex items-start gap-3 py-1 min-h-[44px]">
      <input type="checkbox" className="h-5 w-5 flex-shrink-0 mt-1" checked={checked}
        onChange={() => onToggle(item.id, !checked)}
        aria-label={checked ? 'Uncheck item' : 'Check item'} />
      <div className="flex-1 min-w-0">
        <span className={`block ${checked ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.text}</span>
        {showMeta && (
          <span className="block text-[11px] text-gray-400">
            {addedBy && <>added by {addedBy}</>}
            {checkedBy && <>{addedBy ? ' · ' : ''}✓ {checkedBy}{when ? ` · ${when}` : ''}</>}
          </span>
        )}
      </div>
      <button type="button" onClick={() => onDelete(item.id)} aria-label="Delete item" className="text-gray-300 hover:text-red-500 mt-1">×</button>
    </li>
  )
}
