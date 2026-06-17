import { useCallback, useEffect, useState } from 'react'
import type { ChecklistRow } from '../lib/dbClient/types'
import { getChecklist, setChecklistItemChecked, addChecklistItems, deleteChecklistItem, resetChecklistItems, updateChecklistItem, renameChecklist } from '../services/checklistService'
import { getUsersByIds, type FriendUser } from '../services/relationshipService'

export function useChecklist(id: string) {
  const [checklist, setChecklist] = useState<ChecklistRow | null>(null)
  const [names, setNames] = useState<Record<string, FriendUser>>({})
  const load = useCallback(async () => setChecklist(await getChecklist(id)), [id])
  useEffect(() => {
    let cancelled = false
    void load().catch((e) => { if (!cancelled) console.error('useChecklist: load failed', e) })
    return () => { cancelled = true }
  }, [load])
  // Resolve the people referenced by the list (creator + each item's adder/ticker).
  useEffect(() => {
    if (!checklist) return
    const ids = new Set<string>([checklist.created_by])
    for (const it of checklist.items ?? []) {
      if (it.created_by) ids.add(it.created_by)
      if (it.checked_by) ids.add(it.checked_by)
    }
    let cancelled = false
    void getUsersByIds(Array.from(ids))
      .then((users) => { if (!cancelled) setNames(Object.fromEntries(users.map((u) => [u.id, u]))) })
      .catch((e) => { if (!cancelled) console.error('useChecklist: name resolution failed', e) })
    return () => { cancelled = true }
  }, [checklist])
  const toggle = useCallback(async (itemId: string, checked: boolean) => {
    setChecklist((c) => c && { ...c, items: c.items?.map((i) => i.id === itemId ? { ...i, checked_at: checked ? new Date().toISOString() : null } : i) })
    await setChecklistItemChecked(itemId, checked); await load()
  }, [load])
  const addItems = useCallback(async (texts: string[]) => { await addChecklistItems(id, texts); await load() }, [id, load])
  const removeItem = useCallback(async (itemId: string) => { await deleteChecklistItem(itemId); await load() }, [load])
  const renameItem = useCallback(async (itemId: string, text: string) => {
    setChecklist((c) => c && { ...c, items: c.items?.map((i) => i.id === itemId ? { ...i, text } : i) })
    await updateChecklistItem(itemId, text); await load()
  }, [load])
  const rename = useCallback(async (title: string) => {
    setChecklist((c) => c && { ...c, title })
    await renameChecklist(id, title); await load()
  }, [id, load])
  const resetAll = useCallback(async () => {
    if (!checklist?.items?.length) return
    await resetChecklistItems(checklist.items); await load()
  }, [checklist, load])
  return { checklist, names, reload: load, toggle, addItems, removeItem, renameItem, rename, resetAll }
}
