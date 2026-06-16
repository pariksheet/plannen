import type { ChecklistRow } from '../lib/dbClient/types'

/**
 * Build a trip's compact summary line from its event count and checklists:
 * "4 events · checklist 2/10", "3 events · 2 checklists", or "Empty".
 * A single checklist shows its done/total; multiple show just the count.
 */
export function tripSummary(eventCount: number, checklists: ChecklistRow[]): string {
  const parts: string[] = []
  if (eventCount > 0) parts.push(`${eventCount} event${eventCount === 1 ? '' : 's'}`)
  if (checklists.length === 1) {
    const cl = checklists[0]
    parts.push(`checklist ${cl.done ?? 0}/${cl.total ?? 0}`)
  } else if (checklists.length > 1) {
    parts.push(`${checklists.length} checklists`)
  }
  return parts.length ? parts.join(' · ') : 'Empty'
}
