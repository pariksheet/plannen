import { useCallback, useEffect, useState } from 'react'
import type { ChecklistRow } from '../lib/dbClient/types'
import { listChecklists, createChecklist, deleteChecklist, type NewChecklistItem } from '../services/checklistService'

export function useChecklists(eventId?: string | null) {
  const [checklists, setChecklists] = useState<ChecklistRow[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setChecklists(await listChecklists(eventId)); setLoading(false)
  }, [eventId])
  useEffect(() => {
    let cancelled = false
    void load().catch((e) => { if (!cancelled) console.error('useChecklists: load failed', e) })
    return () => { cancelled = true }
  }, [load])
  const create = useCallback(async (input: { title: string; event_id?: string | null; items?: NewChecklistItem[] }) => { await createChecklist(input); await load() }, [load])
  const remove = useCallback(async (id: string) => { await deleteChecklist(id); await load() }, [load])
  return { checklists, loading, reload: load, create, remove }
}
