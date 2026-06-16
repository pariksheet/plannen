import type { ChecklistItemRow } from '../lib/dbClient/types'
export type { ChecklistRow as Checklist, ChecklistItemRow as ChecklistItem } from '../lib/dbClient/types'

export function checklistProgress(items: Array<Pick<ChecklistItemRow, 'checked_at'>>): { done: number; total: number } {
  return { done: items.filter((i) => i.checked_at != null).length, total: items.length }
}
