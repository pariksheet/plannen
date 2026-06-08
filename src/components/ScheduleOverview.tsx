import { useEffect, useState } from 'react'
import { Event } from '../types/event'
import { getTodayWeather, TodayWeather } from '../services/weatherService'
import { getLocations } from '../services/profileService'
import {
  listPractices, completionsThisWeek, markPracticeDone, unmarkPracticeDone,
} from '../services/practiceService'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'
import { CalendarGrid } from './CalendarGrid'
import { EventCard } from './EventCard'
import { buildWeekAgenda, eventDateLocal, overlappingIds, weekDays, ymd } from '../utils/weekAgenda'
import { defaultCity } from '../utils/homeCity'

export interface ScheduleOverviewProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
  onEdit: (event: Event) => void
  onDelete: (id: string) => void
  onShareSuccess: () => void
  onHashtagClick: (tag: string) => void
}

const sketchHand = "font-['Caveat'] tracking-tight"
const sketchBody = "font-['Kalam']"

function todayIso(): string {
  return ymd(new Date())
}

function weekStartIso(): string {
  return ymd(weekDays(new Date())[0])
}

function timeOf(event: Event): string {
  if (event.start_date.length <= 10) return ''
  const t = new Date(event.start_date)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// Re-renders the caller once a minute so "happening now" / "past" stay live.
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000

type EventTimeState = 'past' | 'now' | 'upcoming'

// Where `event` sits relative to `now`. Timed events use end_date or a 2h
// window; date-only events are "now" all day.
function eventTimeState(event: Event, now: Date): EventTimeState {
  const hasTime = event.start_date.length > 10
  const start = hasTime ? new Date(event.start_date) : null
  let end: Date | null = null
  if (event.end_date) end = new Date(event.end_date)
  else if (start) end = new Date(start.getTime() + DEFAULT_DURATION_MS)
  if (start && end) {
    if (now >= end) return 'past'
    if (now >= start) return 'now'
    return 'upcoming'
  }
  if (!start && end) return now >= end ? 'past' : 'now'
  return 'now'
}

export function ScheduleOverview(props: ScheduleOverviewProps) {
  // Cancelled events don't belong on a schedule — filter once for every card.
  const events = props.events.filter((e) => e.event_status !== 'cancelled')
  return (
    <div className="space-y-4 w-full min-w-0">
      <HeaderStrip />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <RoutinesCard />
      </div>
      <WeekCard
        events={events}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
        onShareSuccess={props.onShareSuccess}
        onHashtagClick={props.onHashtagClick}
      />
      <ThisMonthCard
        events={events}
        preferredVisitDates={props.preferredVisitDates}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
        onShareSuccess={props.onShareSuccess}
        onHashtagClick={props.onHashtagClick}
      />
    </div>
  )
}

function HeaderStrip() {
  const [weather, setWeather] = useState<TodayWeather | null>(null)
  const today = new Date()
  const dateLabel = today.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })
  useEffect(() => {
    let cancelled = false
    void getLocations()
      .then(({ data }) => getTodayWeather(defaultCity(data ?? [])))
      .then((w) => { if (!cancelled) setWeather(w) })
    return () => { cancelled = true }
  }, [])
  return (
    <header className="flex items-baseline justify-between">
      <h2 className={`${sketchHand} text-4xl sm:text-5xl text-gray-900`}>Your Schedule</h2>
      <div className={`${sketchBody} text-right`}>
        <div className="text-base text-gray-700">{dateLabel}</div>
        {weather && (
          <div className="text-sm text-gray-600 capitalize">
            {Math.round(weather.temp_c)}° {weather.summary}
          </div>
        )}
      </div>
    </header>
  )
}

function RoutinesCard() {
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [completions, setCompletions] = useState<PracticeCompletionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [date] = useState(todayIso())

  const refresh = async () => {
    try {
      const [p, c] = await Promise.all([
        listPractices(true),
        completionsThisWeek(weekStartIso()),
      ])
      setPractices(p)
      setCompletions(c)
    } catch (err) {
      console.error('RoutinesCard: failed to load practices', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const isDoneToday = (id: string) =>
    completions.some((c) => c.practice_id === id && c.completed_on === date)

  const toggle = async (p: PracticeRow) => {
    if (isDoneToday(p.id)) await unmarkPracticeDone(p.id, date)
    else await markPracticeDone(p.id, date)
    await refresh()
  }

  if (loading) return null
  if (practices.length === 0) return null

  const visible = practices.slice(0, 6)
  const overflow = practices.length - visible.length

  return (
    <section className={`rounded-xl border-2 border-stone-200/70 bg-stone-50/60 p-4 ${sketchBody}`}>
      <ul className="space-y-1">
        {visible.map((p) => {
          const done = isDoneToday(p.id)
          const weekDone = completions.filter((c) => c.practice_id === p.id).length
          const label = p.frequency_type === 'weekly_count'
            ? `${p.name} (${weekDone}/${p.target_count ?? 0} this week)`
            : p.frequency_type === 'daily' ? `${p.name} (daily)` : p.name
          return (
            <li key={p.id}>
              <label className="flex items-center gap-2 cursor-pointer text-base">
                <input type="checkbox" checked={done} onChange={() => void toggle(p)} className="h-4 w-4" />
                <span className={done ? 'line-through text-gray-400' : 'text-gray-800'}>{label}</span>
              </label>
            </li>
          )
        })}
        {overflow > 0 && (
          <li className="text-xs text-indigo-600">+{overflow} more in Routines</li>
        )}
      </ul>
    </section>
  )
}

interface ActionProps {
  onEdit: (event: Event) => void
  onDelete: (id: string) => void
  onShareSuccess: () => void
  onHashtagClick: (tag: string) => void
}

// The reused timeline card, revealed inline when a schedule row is clicked.
function QuickEventCard({ event, ...actions }: { event: Event } & ActionProps) {
  return (
    <div data-testid="quick-event-card" className="mt-1 mb-2">
      <EventCard
        event={event}
        viewMode="compact"
        showActions
        showRSVP
        onEdit={actions.onEdit}
        onDelete={actions.onDelete}
        onShareSuccess={actions.onShareSuccess}
        onHashtagClick={actions.onHashtagClick}
      />
    </div>
  )
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

// "Mon 8th Jun" from a local date-only key.
function dayLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateKey
  const wd = d.toLocaleDateString(undefined, { weekday: 'short' })
  const mon = d.toLocaleDateString(undefined, { month: 'short' })
  return `${wd} ${ordinal(d.getDate())} ${mon}`
}

type WeekRow =
  | { kind: 'empty'; key: string }
  | { kind: 'event'; key: string; event: Event; isToday: boolean; isPast: boolean; clash: boolean }

function WeekCard({ events, ...actions }: { events: Event[] } & ActionProps) {
  const now = useNow()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const buckets = buildWeekAgenda(events, now)
  const toggle = (id: string) => setSelectedId((cur) => (cur === id ? null : id))
  // Flatten the day buckets into one ordered list of rows so they fill two
  // columns (denser than stacked day-blocks). Today is always represented — as
  // a placeholder row when it has no events. Time clashes are detected per day.
  const rows = buckets.flatMap<WeekRow>((b) => {
    if (b.events.length === 0) return [{ kind: 'empty', key: b.dateKey }]
    const clashes = overlappingIds(b.events)
    return b.events.map((e) => ({
      kind: 'event', key: e.id, event: e, isToday: b.isToday, isPast: b.isPast,
      clash: clashes.has(e.id),
    }))
  })
  return (
    <section data-testid="week-card" className={`rounded-xl border-2 border-emerald-200/70 bg-emerald-50/60 p-4 ${sketchBody}`}>
      <h3 className={`${sketchHand} text-3xl text-gray-900 mb-2`}>This week</h3>
      <ul className="md:columns-2 gap-x-6">
        {rows.map((row) => {
          if (row.kind === 'empty') {
            return (
              <li key={row.key} className="break-inside-avoid mb-1 text-base text-gray-500 rounded bg-yellow-100/60 px-1.5 py-0.5">
                {dayLabel(row.key)} · nothing scheduled
              </li>
            )
          }
          const e = row.event
          const isReminder = e.event_kind === 'reminder'
          const state = row.isToday ? eventTimeState(e, now) : null
          const done = state === 'past'
          const t = timeOf(e)
          const label = `${dayLabel(eventDateLocal(e))}${t ? ` ${t}` : ''}`
          return (
            <li key={row.key} className={`break-inside-avoid mb-1 ${row.isPast ? 'opacity-60' : ''}`}>
              <button
                type="button"
                aria-expanded={selectedId === e.id}
                onClick={() => toggle(e.id)}
                className={`w-full text-left text-base leading-6 hover:text-indigo-700 rounded px-1.5 ${
                  row.isToday ? 'bg-yellow-100/60' : ''
                }`}
              >
                <span className="text-gray-500 text-sm whitespace-nowrap mr-2">{label}</span>
                <span
                  className={`${
                    done ? 'line-through text-gray-400'
                      : state === 'now' ? 'font-semibold text-gray-900'
                        : 'text-gray-800'
                  } ${isReminder ? 'italic text-gray-600' : ''}`}
                >
                  {state === 'now' && <span className="text-indigo-600 font-bold mr-1">→</span>}
                  {e.title}
                  {isReminder && (
                    <span className="ml-1.5 text-[11px] not-italic bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-1.5 py-0.5">
                      reminder
                    </span>
                  )}
                  {row.clash && (
                    <span className="ml-1.5 text-[11px] not-italic whitespace-nowrap bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-1.5 py-0.5">
                      ⚠ overlaps
                    </span>
                  )}
                </span>
              </button>
              {selectedId === e.id && <QuickEventCard event={e} {...actions} />}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function isInCurrentMonth(iso: string | null): boolean {
  if (!iso) return false
  const now = new Date()
  return iso.slice(0, 7) === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Month sidebar: all non-reminder events of the current month (past and
// upcoming). Reminders are deliberately excluded here (noise) — they still
// show on the calendar grid and on day-click; the week card carries them too.
function isInMonthList(event: Event): boolean {
  if (event.event_kind === 'reminder') return false
  if (event.recurrence_rule) return false
  return isInCurrentMonth(event.start_date)
}

interface MonthListEntry {
  key: string
  title: string
  firstEvent: Event
  count: number
}

function buildMonthList(events: Event[]): MonthListEntry[] {
  const groups = new Map<string, MonthListEntry>()
  const sorted = events.filter(isInMonthList).slice().sort(
    (a, b) => a.start_date.localeCompare(b.start_date)
  )
  for (const e of sorted) {
    const groupKey = e.parent_event_id ?? `t:${e.title.toLowerCase()}`
    const existing = groups.get(groupKey)
    if (existing) existing.count += 1
    else groups.set(groupKey, { key: groupKey, title: e.title, firstEvent: e, count: 1 })
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.firstEvent.start_date.localeCompare(b.firstEvent.start_date)
  )
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(5, 10)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function eventsOnDate(events: Event[], dateKey: string): Event[] {
  return events
    .filter((e) => {
      if (e.recurrence_rule) return false
      const startK = eventDateLocal(e)
      const endK = e.end_date ? ymd(new Date(e.end_date)) : startK
      return dateKey >= startK && dateKey <= endK
    })
    .slice()
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
}

function formatLongDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateKey
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

interface ThisMonthCardProps extends ActionProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
}

function ThisMonthCard({ events, preferredVisitDates, ...actions }: ThisMonthCardProps) {
  const monthList = buildMonthList(events)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Switching days clears any open reveal so a stale card can't carry over.
  const chooseDay = (day: string | null) => { setSelectedDay(day); setSelectedId(null) }
  const toggle = (id: string) => setSelectedId((cur) => (cur === id ? null : id))
  const dayEvents = selectedDay ? eventsOnDate(events, selectedDay) : []
  return (
    <section className={`rounded-xl border-2 border-violet-200/70 bg-violet-50/50 p-4 ${sketchBody}`}>
      <h3 className={`${sketchHand} text-3xl text-gray-900 mb-2`}>This month</h3>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
        <div className="min-w-0">
          <CalendarGrid
            events={events}
            preferredVisitDates={preferredVisitDates}
            onDelete={actions.onDelete}
            onShareSuccess={actions.onShareSuccess}
            onDataChange={actions.onShareSuccess}
            onHashtagClick={actions.onHashtagClick}
            onDateSelect={(d) => chooseDay(ymd(d))}
            showActions={false}
            showSidebar={false}
            compact
          />
        </div>
        <aside>
          {selectedDay ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className={`${sketchHand} text-2xl text-gray-900`}>{formatLongDate(selectedDay)}</h4>
                <button
                  type="button"
                  onClick={() => chooseDay(null)}
                  aria-label="Back to upcoming list"
                  className="inline-flex items-center justify-center h-7 w-7 rounded-full text-gray-500 hover:bg-violet-100 hover:text-gray-700"
                >
                  ✕
                </button>
              </div>
              {dayEvents.length === 0 ? (
                <div className="text-base text-gray-500">Nothing on this day.</div>
              ) : (
                <ul className="space-y-0.5">
                  {dayEvents.map((e) => {
                    const time = timeOf(e)
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          aria-expanded={selectedId === e.id}
                          onClick={() => toggle(e.id)}
                          className="block w-full text-left text-base font-semibold text-gray-900 hover:text-indigo-700"
                        >
                          {time && <span className="text-gray-500 mr-2 font-normal">{time}</span>}
                          {e.title}
                        </button>
                        {selectedId === e.id && <QuickEventCard event={e} {...actions} />}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : monthList.length === 0 ? (
            <div className="text-base text-gray-500">Nothing upcoming this month.</div>
          ) : (
            <ul data-testid="month-list" className="md:columns-2 gap-x-4 space-y-0.5">
              {monthList.map((entry) => {
                const time = timeOf(entry.firstEvent)
                const dateLabel = formatShortDate(entry.firstEvent.start_date)
                const suffix = entry.count > 1 ? ` ×${entry.count}` : ''
                return (
                  <li key={entry.key} className="break-inside-avoid">
                    <button
                      type="button"
                      aria-expanded={selectedId === entry.firstEvent.id}
                      onClick={() => toggle(entry.firstEvent.id)}
                      className="block w-full text-left text-base font-semibold text-gray-900 hover:text-indigo-700"
                    >
                      <span className="text-gray-500 mr-2 font-normal">
                        {dateLabel}{time ? ` ${time}` : ''}
                      </span>
                      {entry.title}{suffix && <span className="text-gray-500 font-normal">{suffix}</span>}
                    </button>
                    {selectedId === entry.firstEvent.id && <QuickEventCard event={entry.firstEvent} {...actions} />}
                  </li>
                )
              })}
            </ul>
          )}
        </aside>
      </div>
    </section>
  )
}
