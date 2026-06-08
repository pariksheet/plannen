# Schedule Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Schedule view's Today/This-Week/This-Month cards with a folded day-grouped week (today highlighted), make a clicked event reveal the reused `EventCard` with inline actions, and source weather from the user's default location.

**Architecture:** Two new pure helpers (`buildWeekAgenda`, `defaultCity`) hold the testable logic. `ScheduleOverview.tsx` is rewritten: `TodayCard`/`ThisWeekCard`/`buildWeekList` are deleted in favor of a single `WeekCard` that buckets events by day via `buildWeekAgenda`; clicking a row reveals an inline `EventCard` (compact) instead of opening `EventDetailsModal` directly. `ThisMonthCard` routes its clicks through the same reveal. `HeaderStrip` reads the default `user_location.city` for weather.

**Tech Stack:** React + TypeScript, Vite, Vitest + @testing-library/react + jsdom. Existing components reused: `EventCard`, `EventDetailsModal`, `CalendarGrid`, `RoutinesCard`. Spec: `docs/superpowers/specs/2026-06-08-schedule-redesign-design.md`.

**Branch:** `redesign/schedule-page` (already checked out; spec already committed there).

---

## File structure

- **Create** `src/utils/weekAgenda.ts` — `weekDays`, `ymd`, `eventDateLocal`, `DayBucket`, `buildWeekAgenda` (pure week-bucketing logic).
- **Create** `src/utils/weekAgenda.test.ts` — unit tests for `buildWeekAgenda`.
- **Create** `src/utils/homeCity.ts` — `defaultCity(locations)` (pure).
- **Create** `src/utils/homeCity.test.ts` — unit tests for `defaultCity`.
- **Rewrite** `src/components/ScheduleOverview.tsx` — new `WeekCard` + `QuickEventCard`; delete `TodayCard`, `ThisWeekCard`, `buildWeekList`, `WeekListEntry`, `isTodayStrict`; `HeaderStrip` weather wiring; `ThisMonthCard` click → reveal.
- **Rewrite** `src/components/ScheduleOverview.test.tsx` — adapt to the new structure (mock `./EventCard` instead of `./EventDetailsModal`; mock `getLocations`).

**Note on mobile presentation:** The spec mentions a bottom sheet on phones. To reduce risk this plan implements a single inline reveal at all sizes (the reused `EventCard` is already mobile-responsive). A dedicated bottom sheet can be a follow-up.

---

## Task 1: `buildWeekAgenda` pure helper

**Files:**
- Create: `src/utils/weekAgenda.ts`
- Test: `src/utils/weekAgenda.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/weekAgenda.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildWeekAgenda, ymd } from './weekAgenda'
import { Event } from '../types/event'

function ev(overrides: Partial<Event>): Event {
  return {
    id: 'e', title: 'Untitled', description: null,
    start_date: '2026-06-10', end_date: null,
    enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
    image_url: null, location: null, hashtags: null,
    event_kind: 'event', event_type: 'personal', event_status: 'going',
    created_by: 'u1', created_at: '2026-06-10', updated_at: '2026-06-10',
    shared_with_friends: 'none', ...overrides,
  } as Event
}

// Wednesday 2026-06-10 (week Mon 8 … Sun 14)
const NOW = new Date('2026-06-10T09:00:00')

describe('buildWeekAgenda', () => {
  it('always includes today even with no events, omitting other empty days', () => {
    const buckets = buildWeekAgenda([], NOW)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].isToday).toBe(true)
    expect(buckets[0].dateKey).toBe(ymd(NOW))
    expect(buckets[0].events).toHaveLength(0)
  })

  it('buckets events onto their local day and sorts within a day', () => {
    const buckets = buildWeekAgenda([
      ev({ id: 'b', title: 'B', start_date: '2026-06-10T18:00:00' }),
      ev({ id: 'a', title: 'A', start_date: '2026-06-10T08:00:00' }),
    ], NOW)
    const today = buckets.find((d) => d.isToday)!
    expect(today.events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('includes reminders, including past ones in the week', () => {
    const buckets = buildWeekAgenda([
      ev({ id: 'r', title: 'Renew books', event_kind: 'reminder', start_date: '2026-06-08' }),
    ], NOW)
    const mon = buckets.find((d) => d.dateKey === '2026-06-08')!
    expect(mon.isPast).toBe(true)
    expect(mon.events.map((e) => e.id)).toEqual(['r'])
  })

  it('excludes recurrence parents and out-of-week events', () => {
    const buckets = buildWeekAgenda([
      ev({ id: 'p', title: 'Parent', recurrence_rule: 'WEEKLY', start_date: '2026-06-10' } as Partial<Event>),
      ev({ id: 'far', title: 'Far', start_date: '2026-07-01' }),
    ], NOW)
    const all = buckets.flatMap((d) => d.events.map((e) => e.id))
    expect(all).not.toContain('p')
    expect(all).not.toContain('far')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/weekAgenda.test.ts`
Expected: FAIL — cannot find module `./weekAgenda`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/weekAgenda.ts`:

```ts
import { Event } from '../types/event'

export interface DayBucket {
  dateKey: string   // "YYYY-MM-DD" local day
  weekday: string   // localized short label, e.g. "Wed"
  dayNum: number    // 10
  isToday: boolean
  isPast: boolean    // whole day before today
  events: Event[]    // sorted ascending by start_date
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Date-only ISO ("2026-06-10") taken as-is; a timestamp is converted to the
// user's local date.
export function eventDateLocal(event: Event): string {
  if (event.start_date.length <= 10) return event.start_date.slice(0, 10)
  const d = new Date(event.start_date)
  if (Number.isNaN(d.getTime())) return event.start_date.slice(0, 10)
  return ymd(d)
}

// Monday..Sunday of the week containing `now`.
export function weekDays(now: Date): Date[] {
  const dow = now.getDay() || 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dow - 1))
  monday.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

// Buckets events into the current Mon–Sun week, one entry per day that has
// events (today is always included even if empty; other empty days are
// omitted). Recurrence parents are skipped; reminders are kept, including
// past ones.
export function buildWeekAgenda(events: Event[], now: Date): DayBucket[] {
  const days = weekDays(now)
  const todayKey = ymd(now)
  const weekStart = ymd(days[0])
  const weekEnd = ymd(days[6])

  const byDay = new Map<string, Event[]>()
  for (const e of events) {
    if (e.recurrence_rule) continue
    const k = eventDateLocal(e)
    if (k < weekStart || k > weekEnd) continue
    const arr = byDay.get(k) ?? []
    arr.push(e)
    byDay.set(k, arr)
  }

  const buckets: DayBucket[] = []
  for (const d of days) {
    const dateKey = ymd(d)
    const isToday = dateKey === todayKey
    const evs = (byDay.get(dateKey) ?? []).slice()
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
    if (evs.length === 0 && !isToday) continue
    buckets.push({
      dateKey,
      weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
      dayNum: d.getDate(),
      isToday,
      isPast: dateKey < todayKey,
      events: evs,
    })
  }
  return buckets
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/weekAgenda.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/weekAgenda.ts src/utils/weekAgenda.test.ts
git commit -m "feat(schedule): add buildWeekAgenda week-bucketing helper"
```

---

## Task 2: `defaultCity` weather-location helper

**Files:**
- Create: `src/utils/homeCity.ts`
- Test: `src/utils/homeCity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/homeCity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { defaultCity } from './homeCity'
import type { UserLocation } from '../services/profileService'

function loc(overrides: Partial<UserLocation>): UserLocation {
  return {
    id: 'l', user_id: 'u', label: 'Home', address: '', city: 'Antwerp',
    country: 'BE', is_default: false, ...overrides,
  }
}

describe('defaultCity', () => {
  it('returns the default location city', () => {
    expect(defaultCity([
      loc({ id: 'a', city: 'Ghent', is_default: false }),
      loc({ id: 'b', city: 'Leuven', is_default: true }),
    ])).toBe('Leuven')
  })

  it('falls back to Brussels when there is no default', () => {
    expect(defaultCity([loc({ city: 'Ghent', is_default: false })])).toBe('Brussels')
    expect(defaultCity([])).toBe('Brussels')
  })

  it('falls back to Brussels when the default city is blank', () => {
    expect(defaultCity([loc({ city: '   ', is_default: true })])).toBe('Brussels')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/homeCity.test.ts`
Expected: FAIL — cannot find module `./homeCity`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/homeCity.ts`:

```ts
import type { UserLocation } from '../services/profileService'

// The city to use for weather: the user's default location, else Brussels.
// The weather service maps a small set of cities and itself falls back to
// Brussels for anything unmapped, so passing the raw city string is safe.
export function defaultCity(locations: UserLocation[], fallback = 'Brussels'): string {
  const def = locations.find((l) => l.is_default)
  const city = def?.city?.trim()
  return city || fallback
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/homeCity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/homeCity.ts src/utils/homeCity.test.ts
git commit -m "feat(schedule): add defaultCity weather-location helper"
```

---

## Task 3: Rewrite `ScheduleOverview` — `WeekCard` + `QuickEventCard`, location-aware weather

This task replaces the body of `ScheduleOverview.tsx`. The test file is rewritten in Task 4, so after this task the **old** test file will fail to compile (it imports the deleted modal mock shape) — that is expected and fixed in Task 4. Verify this task via the new helper tests already passing plus a typecheck.

**Files:**
- Rewrite: `src/components/ScheduleOverview.tsx`

- [ ] **Step 1: Replace the file contents**

Overwrite `src/components/ScheduleOverview.tsx` with:

```tsx
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
import { buildWeekAgenda, eventDateLocal, ymd } from '../utils/weekAgenda'
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
  const d = new Date()
  const dow = d.getDay() || 7
  d.setDate(d.getDate() - (dow - 1))
  return ymd(d)
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

function WeekCard({ events, ...actions }: { events: Event[] } & ActionProps) {
  const now = useNow()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const buckets = buildWeekAgenda(events, now)
  const toggle = (id: string) => setSelectedId((cur) => (cur === id ? null : id))
  return (
    <section className={`rounded-xl border-2 border-emerald-200/70 bg-emerald-50/60 p-4 ${sketchBody}`}>
      <h3 className={`${sketchHand} text-3xl text-gray-900 mb-2`}>This week</h3>
      <div className="space-y-2">
        {buckets.map((b) => (
          <div
            key={b.dateKey}
            className={
              b.isToday
                ? 'rounded-lg bg-yellow-100/70 border border-dashed border-yellow-500/50 px-2 py-1.5'
                : b.isPast ? 'opacity-60 px-2' : 'px-2'
            }
          >
            <div className={`text-xs uppercase tracking-wide mb-1 ${b.isToday ? 'text-yellow-800' : 'text-gray-500'}`}>
              {b.weekday} <span className="text-sm font-bold normal-case tracking-normal">{b.dayNum}</span>
              {b.isToday && <span className="ml-1 normal-case tracking-normal text-yellow-700">· today</span>}
            </div>
            {b.events.length === 0 ? (
              <div className="text-base text-gray-500">Nothing scheduled — enjoy the day.</div>
            ) : (
              <ul className="space-y-0.5">
                {b.events.map((e) => {
                  const isReminder = e.event_kind === 'reminder'
                  const state = b.isToday ? eventTimeState(e, now) : null
                  const done = state === 'past'
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => toggle(e.id)}
                        className={`w-full text-left text-base hover:text-indigo-700 flex items-baseline gap-2 ${
                          done ? 'line-through text-gray-400'
                            : state === 'now' ? 'font-semibold text-gray-900'
                              : 'text-gray-800'
                        }`}
                      >
                        <span className="text-gray-500 w-12 shrink-0">
                          {state === 'now' ? '→' : (timeOf(e) || (isReminder ? '' : 'all-day'))}
                        </span>
                        <span className={isReminder ? 'italic text-gray-600' : ''}>
                          {e.title}
                          {isReminder && (
                            <span className="ml-1.5 text-[11px] not-italic bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-1.5 py-0.5">
                              reminder
                            </span>
                          )}
                        </span>
                      </button>
                      {selectedId === e.id && <QuickEventCard event={e} {...actions} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function isInCurrentMonth(iso: string | null): boolean {
  if (!iso) return false
  const now = new Date()
  return iso.slice(0, 7) === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Month sidebar: upcoming non-reminder events of the current month. Reminders
// are deliberately excluded here (noise) — the week card carries them instead.
function isInMonthList(event: Event): boolean {
  if (event.event_kind === 'reminder') return false
  if (event.recurrence_rule) return false
  if (!isInCurrentMonth(event.start_date)) return false
  return eventDateLocal(event) >= todayIso()
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
            onDateSelect={(d) => setSelectedDay(ymd(d))}
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
                  onClick={() => setSelectedDay(null)}
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
                  {dayEvents.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => toggle(e.id)}
                        className="block w-full text-left text-base font-semibold text-gray-900 hover:text-indigo-700"
                      >
                        {timeOf(e) && <span className="text-gray-500 mr-2 font-normal">{timeOf(e)}</span>}
                        {e.title}
                      </button>
                      {selectedId === e.id && <QuickEventCard event={e} {...actions} />}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : monthList.length === 0 ? (
            <div className="text-base text-gray-500">Nothing upcoming this month.</div>
          ) : (
            <ul className="md:columns-2 gap-x-4 space-y-0.5">
              {monthList.map((entry) => {
                const time = timeOf(entry.firstEvent)
                const dateLabel = formatShortDate(entry.firstEvent.start_date)
                const suffix = entry.count > 1 ? ` ×${entry.count}` : ''
                return (
                  <li key={entry.key} className="break-inside-avoid">
                    <button
                      type="button"
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
```

- [ ] **Step 2: Typecheck the new file**

Run: `npx tsc -b tsconfig.build.json`
Expected: PASS (no type errors). The old test file is not part of the build tsconfig, so it does not block this. If `tsconfig.build.json` excludes tests it will pass; if it errors only on `*.test.tsx`, ignore those — Task 4 fixes the test.

- [ ] **Step 3: Commit**

```bash
git add src/components/ScheduleOverview.tsx
git commit -m "feat(schedule): fold Today into a day-grouped WeekCard; reveal reused EventCard on click; location-aware weather"
```

---

## Task 4: Rewrite `ScheduleOverview.test.tsx` for the new structure

**Files:**
- Rewrite: `src/components/ScheduleOverview.test.tsx`

- [ ] **Step 1: Replace the test file**

Overwrite `src/components/ScheduleOverview.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ScheduleOverview } from './ScheduleOverview'
import { Event } from '../types/event'

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: null })),
}))
vi.mock('../services/weatherService', () => ({
  getTodayWeather: vi.fn(async () => null),
}))
vi.mock('../services/profileService', () => ({
  getLocations: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../services/practiceService', () => ({
  listPractices: vi.fn(async () => []),
  completionsThisWeek: vi.fn(async () => []),
  markPracticeDone: vi.fn(async () => {}),
  unmarkPracticeDone: vi.fn(async () => {}),
}))
// Stub the reused timeline card — its real services are exercised in its own
// test. Expose Edit/Delete buttons so we can assert the reveal wires actions.
vi.mock('./EventCard', () => ({
  EventCard: ({ event, onEdit, onDelete }: { event: Event; onEdit?: (e: Event) => void; onDelete?: (id: string) => void }) => (
    <div data-testid="event-card">
      <span>Card: {event.title}</span>
      {onEdit && <button type="button" onClick={() => onEdit(event)}>Edit event</button>}
      {onDelete && <button type="button" onClick={() => onDelete(event.id)}>Delete event</button>}
    </div>
  ),
}))
// CalendarGrid pulls in heavy deps; stub to a marker. The month list/sidebar
// under test is rendered by ScheduleOverview itself, not CalendarGrid.
vi.mock('./CalendarGrid', () => ({
  CalendarGrid: () => <div data-testid="calendar-grid" />,
}))

function renderOverview(events: Event[] = [], onEdit = vi.fn()) {
  return render(
    <MemoryRouter>
      <ScheduleOverview
        events={events}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onShareSuccess={vi.fn()}
        onHashtagClick={vi.fn()}
        preferredVisitDates={{}}
      />
    </MemoryRouter>
  )
}

function makeEvent(overrides: Partial<Event>): Event {
  const today = new Date().toISOString().slice(0, 10)
  return {
    id: overrides.id ?? 'e1', title: 'Untitled', description: null,
    start_date: today, end_date: null,
    enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
    image_url: null, location: null, hashtags: null,
    event_kind: 'event', event_type: 'personal', event_status: 'going',
    created_by: 'u1', created_at: today, updated_at: today,
    shared_with_friends: 'none', ...overrides,
  } as Event
}

// Wednesday of the current week — always inside the rendered Mon–Sun window.
function midWeekIso(): string {
  const d = new Date()
  const dow = d.getDay() || 7
  d.setDate(d.getDate() - (dow - 1) + 2)
  return d.toISOString().slice(0, 10)
}

describe('ScheduleOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the schedule sections (no separate Today card)', () => {
    renderOverview([])
    expect(screen.getByText('Your Schedule')).toBeInTheDocument()
    expect(screen.getByText('This week')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()
    expect(screen.queryByText('Today')).not.toBeInTheDocument()
  })

  it('renders the header date', () => {
    renderOverview([])
    expect(screen.getAllByText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d+$/).length)
      .toBeGreaterThanOrEqual(1)
  })

  it('reads weather for the default location', async () => {
    const { getLocations } = await import('../services/profileService')
    const { getTodayWeather } = await import('../services/weatherService')
    vi.mocked(getLocations).mockResolvedValue({
      data: [{ id: 'l', user_id: 'u', label: 'Home', address: '', city: 'Ghent', country: 'BE', is_default: true }],
      error: null,
    })
    renderOverview([])
    await vi.waitFor(() => {
      expect(vi.mocked(getTodayWeather)).toHaveBeenCalledWith('Ghent')
    })
  })

  it('renders compact weather (temp + summary) next to the heading', async () => {
    const { getTodayWeather } = await import('../services/weatherService')
    vi.mocked(getTodayWeather).mockResolvedValue({
      city: 'Brussels', temp_c: 24, summary: 'clear', chips: [], fetched_at: new Date().toISOString(),
    })
    renderOverview([])
    expect(await screen.findByText(/24°\s*clear/)).toBeInTheDocument()
  })

  it('lists practices and toggles completion', async () => {
    const { listPractices, completionsThisWeek, markPracticeDone } = await import('../services/practiceService')
    vi.mocked(listPractices).mockResolvedValue([
      { id: 'p1', name: 'Sunscreen', frequency_type: 'daily', target_count: null } as never,
      { id: 'p2', name: 'Gym', frequency_type: 'weekly_count', target_count: 3 } as never,
    ])
    vi.mocked(completionsThisWeek).mockResolvedValue([])
    renderOverview([])
    expect(await screen.findByText(/Sunscreen \(daily\)/)).toBeInTheDocument()
    expect(screen.getByText(/Gym \(0\/3 this week\)/)).toBeInTheDocument()
    screen.getAllByRole('checkbox')[0].click()
    expect(vi.mocked(markPracticeDone)).toHaveBeenCalledWith('p1', expect.any(String))
  })

  it('renders a today event inside the week card', () => {
    renderOverview([makeEvent({ id: 'e1', title: 'Weekly call', start_date: new Date().toISOString().slice(0, 10) })])
    expect(screen.getByText('Weekly call')).toBeInTheDocument()
  })

  it('renders a reminder in the week with a tag', () => {
    renderOverview([makeEvent({ id: 'r1', title: 'Renew books', event_kind: 'reminder', start_date: midWeekIso() })])
    expect(screen.getByText('Renew books')).toBeInTheDocument()
    expect(screen.getByText('reminder')).toBeInTheDocument()
  })

  it('lists upcoming month events in the sidebar and excludes reminders', () => {
    const today = new Date()
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const day = Math.min(today.getDate() + 1, lastDay)
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const iso = `${thisMonth}-${String(day).padStart(2, '0')}`
    renderOverview([
      makeEvent({ id: 'm1', title: 'Camp deadline', start_date: iso }),
      makeEvent({ id: 'mr', title: 'Renew passport', event_kind: 'reminder', start_date: iso }),
    ])
    // Camp deadline appears in the month sidebar list.
    expect(screen.getAllByText('Camp deadline').length).toBeGreaterThanOrEqual(1)
    // The reminder is not in the month list (it may still be in the week card,
    // so assert it is absent from the month sidebar only via passport title).
    expect(screen.queryByText('Renew passport')).not.toBeInTheDocument()
  })

  it('hides cancelled events', () => {
    renderOverview([
      makeEvent({ id: 'c1', title: 'Cancelled today', start_date: new Date().toISOString().slice(0, 10), event_status: 'cancelled' }),
    ])
    expect(screen.queryByText('Cancelled today')).not.toBeInTheDocument()
  })

  it('clicking a row reveals the reused EventCard, whose Edit enters edit mode', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const event = makeEvent({ id: 'e9', title: 'Weekly call', start_date: new Date().toISOString().slice(0, 10) })
    renderOverview([event], onEdit)
    expect(screen.queryByTestId('quick-event-card')).not.toBeInTheDocument()
    await user.click(screen.getByText('Weekly call'))
    expect(screen.getByTestId('quick-event-card')).toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
    await user.click(screen.getByText('Edit event'))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'e9' }))
  })
})
```

- [ ] **Step 2: Run the test file to verify it passes**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS (all tests). If the `reads weather for the default location` test is flaky on the `mockResolvedValueOnce?.` line, delete that line — the following `mockResolvedValue` line is sufficient.

- [ ] **Step 3: Commit**

```bash
git add src/components/ScheduleOverview.test.tsx
git commit -m "test(schedule): cover WeekCard, reminder tag, EventCard reveal, location weather"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test:run`
Expected: PASS. If any other test referenced the deleted `TodayCard`/`ThisWeekCard` titles or the old click-opens-modal behavior, fix those tests to match the new structure (search: `grep -rn "Today" src --include=*.test.tsx`).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors in `src/utils/weekAgenda.ts`, `src/utils/homeCity.ts`, `src/components/ScheduleOverview.tsx`. Fix any unused-import warnings (e.g. ensure no leftover `EventDetailsModal` import).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (tsc + vite build succeed).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `npx plannen up` then open `http://localhost:4321`. Verify: the Schedule view shows one week list with today highlighted in yellow, dates on each day, a reminder with a tag, clicking a row reveals the card with Edit/Delete, and the header weather reflects your default location's city.

- [ ] **Step 5: Final commit (if Step 1/2 required fixes)**

```bash
git add -A
git commit -m "chore(schedule): fix remaining tests/lint after redesign"
```

---

## Self-review notes (planner)

- **Spec coverage:** WeekCard fold (Task 3) · dates per day (Task 3 `dayNum`) · today highlight (Task 3) · earlier days dimmed (Task 3 `isPast`) · reminders incl. past with tag (Tasks 1 + 3/4) · month still excludes reminders (Task 3 `isInMonthList`) · click→reused EventCard with Delete (Tasks 3/4) · weather from default location (Tasks 2/3) · empty-day rule (Task 1) — all covered.
- **Deviation flagged:** mobile bottom-sheet simplified to inline reveal at all sizes (noted in File Structure). Confirm acceptable, else add a follow-up task for a portal bottom sheet.
- **Type consistency:** `ActionProps` reused across `WeekCard`, `ThisMonthCard`, `QuickEventCard`; `DayBucket` fields match between `buildWeekAgenda` and `WeekCard`; `getLocations()` returns `{ data, error }` (per `profileService.ts`) and is consumed as `data ?? []`.
