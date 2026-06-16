import { dbClient } from '../lib/dbClient'
import type { ChecklistRow, ChecklistItemRow } from '../lib/dbClient/types'

/** A starter item for a new checklist. `checked` pre-marks it done at creation
 *  (records checked_at/checked_by via the normal toggle path). */
export type NewChecklistItem = { text: string; checked?: boolean }

export const listChecklists = (eventId?: string | null): Promise<ChecklistRow[]> => dbClient.checklists.list({ event_id: eventId ?? undefined })
export const getChecklist = (id: string): Promise<ChecklistRow> => dbClient.checklists.get(id)

/**
 * Create a checklist with starter items. Items are inserted unchecked through
 * the data layer (which takes plain text), then any the creator pre-checked are
 * ticked via setItemChecked so checked_at/checked_by are recorded — keeping the
 * data layer + MCP create path unchanged (text-only).
 */
export const createChecklist = async (input: { title: string; event_id?: string | null; items?: NewChecklistItem[] }): Promise<ChecklistRow> => {
  const items = (input.items ?? []).filter((i) => i.text.trim().length > 0)
  const cl = await dbClient.checklists.create({ title: input.title, event_id: input.event_id, items: items.map((i) => i.text) })
  // dbClient.create returns items in insertion order, so they line up with
  // `items` index-for-index (both already drop empty-text entries).
  const toCheck = (cl.items ?? []).filter((_, idx) => items[idx]?.checked)
  if (!toCheck.length) return cl
  await Promise.all(toCheck.map((row) => dbClient.checklists.setItemChecked(row.id, true)))
  return dbClient.checklists.get(cl.id)
}
export const renameChecklist = (id: string, title: string): Promise<ChecklistRow> => dbClient.checklists.update(id, { title })
export const deleteChecklist = (id: string): Promise<void> => dbClient.checklists.delete(id)
export const addChecklistItems = (id: string, items: string[]): Promise<ChecklistItemRow[]> => dbClient.checklists.addItems(id, items)
export const setChecklistItemChecked = (itemId: string, checked: boolean): Promise<ChecklistItemRow> => dbClient.checklists.setItemChecked(itemId, checked)

/** Uncheck every currently-checked item in a checklist (keeps the items). */
export const resetChecklistItems = async (items: ChecklistItemRow[]): Promise<void> => {
  await Promise.all(items.filter((i) => i.checked_at != null).map((i) => dbClient.checklists.setItemChecked(i.id, false)))
}
export const updateChecklistItem = (itemId: string, text: string): Promise<ChecklistItemRow> => dbClient.checklists.updateItem(itemId, text)
export const deleteChecklistItem = (itemId: string): Promise<void> => dbClient.checklists.deleteItem(itemId)
export const shareChecklist = (id: string, input: { user_ids?: string[]; group_ids?: string[] }): Promise<void> => dbClient.checklists.share(id, input)
