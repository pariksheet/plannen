import { useCallback, useEffect, useState } from 'react'
import type { ChecklistRow } from '../lib/dbClient/types'
import { getChecklist, setChecklistItemChecked, addChecklistItems, deleteChecklistItem } from '../services/checklistService'

export function useChecklist(id: string) {
  const [checklist, setChecklist] = useState<ChecklistRow | null>(null)
  const load = useCallback(async () => setChecklist(await getChecklist(id)), [id])
  useEffect(() => {
    let cancelled = false
    void load().catch((e) => { if (!cancelled) console.error('useChecklist: load failed', e) })
    return () => { cancelled = true }
  }, [load])
  const toggle = useCallback(async (itemId: string, checked: boolean) => {
    setChecklist((c) => c && { ...c, items: c.items?.map((i) => i.id === itemId ? { ...i, checked_at: checked ? new Date().toISOString() : null } : i) })
    await setChecklistItemChecked(itemId, checked); await load()
  }, [load])
  const addItems = useCallback(async (texts: string[]) => { await addChecklistItems(id, texts); await load() }, [id, load])
  const removeItem = useCallback(async (itemId: string) => { await deleteChecklistItem(itemId); await load() }, [load])
  return { checklist, reload: load, toggle, addItems, removeItem }
}
