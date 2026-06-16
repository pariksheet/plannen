import { dbClient } from '../lib/dbClient'
import type { ChecklistRow, ChecklistItemRow } from '../lib/dbClient/types'

export const listChecklists = (eventId?: string | null): Promise<ChecklistRow[]> => dbClient.checklists.list({ event_id: eventId ?? undefined })
export const getChecklist = (id: string): Promise<ChecklistRow> => dbClient.checklists.get(id)
export const createChecklist = (input: { title: string; event_id?: string | null; items?: string[] }): Promise<ChecklistRow> => dbClient.checklists.create(input)
export const deleteChecklist = (id: string): Promise<void> => dbClient.checklists.delete(id)
export const addChecklistItems = (id: string, items: string[]): Promise<ChecklistItemRow[]> => dbClient.checklists.addItems(id, items)
export const setChecklistItemChecked = (itemId: string, checked: boolean): Promise<ChecklistItemRow> => dbClient.checklists.setItemChecked(itemId, checked)
export const updateChecklistItem = (itemId: string, text: string): Promise<ChecklistItemRow> => dbClient.checklists.updateItem(itemId, text)
export const deleteChecklistItem = (itemId: string): Promise<void> => dbClient.checklists.deleteItem(itemId)
export const shareChecklist = (id: string, input: { user_ids?: string[]; group_ids?: string[] }): Promise<void> => dbClient.checklists.share(id, input)
