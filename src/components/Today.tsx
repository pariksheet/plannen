import { useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import type { DailyBriefingRow } from '../lib/dbClient/types'
import { getTodayBriefing } from '../services/briefingService'
import { useTodayRoutines } from '../hooks/useTodayRoutines'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function Today() {
  const [date] = useState(todayIso())
  const [briefing, setBriefing] = useState<DailyBriefingRow | null>(null)
  const [loading, setLoading] = useState(true)
  const { routines, toggle } = useTodayRoutines(date)

  const refresh = useCallback(async () => {
    setLoading(true)
    const b = await getTodayBriefing(date)
    setBriefing(b)
    setLoading(false)
  }, [date])

  useEffect(() => { void refresh() }, [refresh])

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

      {routines.length > 0 && (
        <ul className="space-y-2">
          {routines.map((r) => (
            <li key={r.id}>
              <label className="flex items-center gap-3 cursor-pointer min-h-[44px] py-1">
                <input
                  type="checkbox"
                  className="h-5 w-5 flex-shrink-0"
                  checked={r.done}
                  onChange={() => void toggle(r.id)}
                  aria-label={r.done ? 'Mark not done' : 'Mark done'}
                />
                {r.timeLabel && (
                  <span className="text-gray-500 text-sm whitespace-nowrap">{r.timeLabel}</span>
                )}
                <span className={r.done ? 'line-through text-gray-400' : ''}>{r.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
