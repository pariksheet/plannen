import type { ChecklistItemRow as Item } from '../lib/dbClient/types'

interface Props { item: Item; onToggle: (id: string, checked: boolean) => void; onDelete: (id: string) => void }

export function ChecklistItemRow({ item, onToggle, onDelete }: Props) {
  const checked = item.checked_at != null
  return (
    <li className="flex items-center gap-3 min-h-[44px] py-1">
      <input type="checkbox" className="h-5 w-5 flex-shrink-0" checked={checked}
        onChange={() => onToggle(item.id, !checked)}
        aria-label={checked ? 'Uncheck item' : 'Check item'} />
      <span className={`flex-1 ${checked ? 'line-through text-gray-400' : 'text-gray-900'}`}>{item.text}</span>
      <button type="button" onClick={() => onDelete(item.id)} aria-label="Delete item" className="text-gray-300 hover:text-red-500">×</button>
    </li>
  )
}
