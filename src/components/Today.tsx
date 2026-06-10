import { useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import type { DailyBriefingRow, PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import {
  listPractices,
  markPracticeDone,
  unmarkPracticeDone,
  completionsThisWeek,
} from '../services/practiceService'
import { getTodayBriefing } from '../services/briefingService'
import { practiceLabel, doneThisPeriod, monthStartIso } from '../utils/practiceLabel'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const js = d.getUTCDay() || 7 // Sun = 7
  d.setUTCDate(d.getUTCDate() - (js - 1))
  return d.toISOString().slice(0, 10)
}

export function Today() {
  const [date] = useState(todayIso())
  const [briefing, setBriefing] = useState<DailyBriefingRow | null>(null)
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [completions, setCompletions] = useState<PracticeCompletionRow[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const ms = monthStartIso(date)
    const ws = weekStart(date)
    const periodFrom = ms < ws ? ms : ws
    const [b, p, c] = await Promise.all([
      getTodayBriefing(date),
      listPractices(true),
      completionsThisWeek(periodFrom),
    ])
    setBriefing(b)
    setPractices(p)
    setCompletions(c)
    setLoading(false)
  }, [date])

  useEffect(() => { void refresh() }, [refresh])

  const isDoneToday = (practiceId: string) =>
    completions.some((c) => c.practice_id === practiceId && c.completed_on === date)

  const toggle = async (p: PracticeRow) => {
    if (isDoneToday(p.id)) {
      await unmarkPracticeDone(p.id, date)
    } else {
      await markPracticeDone(p.id, date)
    }
    await refresh()
  }

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm text-gray-500">{date}</p>
      </header>

      <section>
        <h2 className="text-lg font-medium mb-2">Briefing</h2>
        {briefing ? (
          <article className="prose prose-sm max-w-none text-sm leading-relaxed bg-gray-50 rounded p-4 border border-gray-200">
            <ReactMarkdown>{briefing.content_md}</ReactMarkdown>
          </article>
        ) : (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-600">
            No briefing for today yet. Ask Claude: <code>/plannen-today</code>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Practices</h2>
        {practices.length === 0 ? (
          <p className="text-sm text-gray-500">
            No practices defined. Ask Claude to add one (e.g. "add gym 3×/week").
          </p>
        ) : (
          <ul className="space-y-2">
            {practices.map((p) => {
              const done = isDoneToday(p.id)
              const periodDone = doneThisPeriod(p, completions, weekStart(date), date)
              const label = practiceLabel(p, periodDone)
              return (
                <li key={p.id}>
                  <label className="flex items-center gap-3 cursor-pointer min-h-[44px] py-1">
                    <input type="checkbox" checked={done} onChange={() => void toggle(p)}
                           className="h-5 w-5 flex-shrink-0" />
                    <span className={done ? 'line-through text-gray-400' : ''}>{label}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
