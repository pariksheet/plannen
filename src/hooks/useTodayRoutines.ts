import { useCallback, useEffect, useState } from 'react'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import {
  listPractices, completionsThisWeek, markPracticeDone, unmarkPracticeDone,
} from '../services/practiceService'
import { monthStartIso } from '../utils/practiceLabel'
import { weekBoundaryStart } from '../utils/scheduling'
import { applicableTodayRoutines, type TodayRoutine } from '../utils/routineToday'

/** Fetches active practices + this-period completions and returns the routines
 *  applicable today (pinned-due + flex-under-target), part-of-day sorted, plus a
 *  toggle. Single source of routine logic for both the Schedule and Today views. */
export function useTodayRoutines(date: string): {
  routines: TodayRoutine[]
  toggle: (id: string) => Promise<void>
  loading: boolean
} {
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [completions, setCompletions] = useState<PracticeCompletionRow[]>([])
  const [loading, setLoading] = useState(true)

  const weekStart = weekBoundaryStart(date)
  // Cover month-period flex routines: fetch since the earlier of week- and month-start.
  const monthStart = monthStartIso(date)
  const periodFrom = monthStart < weekStart ? monthStart : weekStart

  const load = useCallback(async () => {
    const [ps, cs] = await Promise.all([listPractices(true), completionsThisWeek(periodFrom)])
    setPractices(ps)
    setCompletions(cs)
    setLoading(false)
  }, [periodFrom])

  useEffect(() => {
    let cancelled = false
    void load().catch((err) => { if (!cancelled) console.error('useTodayRoutines: load failed', err) })
    return () => { cancelled = true }
  }, [load])

  const routines = applicableTodayRoutines(practices, completions, date, weekStart)

  const toggle = useCallback(async (id: string) => {
    const isDone = completions.some((c) => c.practice_id === id && c.completed_on === date)
    if (isDone) await unmarkPracticeDone(id, date)
    else await markPracticeDone(id, date)
    await load()
  }, [completions, date, load])

  return { routines, toggle, loading }
}
