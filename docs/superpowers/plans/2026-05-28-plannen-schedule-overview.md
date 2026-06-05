# Schedule Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Schedule pill (third, leftmost) to the My Plans view-mode toggle that renders a synthesised dashboard: header + family tag, weather (meteo.be), routines (interactive), today, this week, this month.

**Architecture:** Single new component `ScheduleOverview` consumes the events array `MyFeed` already fetches and dispatches by date window into Today / This week / This month panels. A new `weatherService` adds the only external fetch (session-cached). Routines reuse the existing `practiceService` path. `usePrimaryGroup` powers the family tag.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind. Tests in Vitest + `@testing-library/react`. No DB / edge function / MCP changes.

**Spec:** `docs/superpowers/specs/2026-05-28-plannen-schedule-overview-design.md`

---

## File Map

Create:
- `src/services/weatherService.ts` — meteo.be fetch + sessionStorage cache + graceful failure.
- `src/services/weatherService.test.ts` — unit tests for the service.
- `src/components/ScheduleOverview.tsx` — the new view component.
- `src/components/ScheduleOverview.test.tsx` — render tests.

Modify:
- `src/types/event.ts` — extend `EventViewMode` with `'schedule'`.
- `src/components/MyFeed.tsx` — third pill, dispatch when `viewMode === 'schedule'`, hydrator accepts `'schedule'`.

---

## Task 1: Extend EventViewMode and add Schedule pill (stub)

**Files:**
- Modify: `src/types/event.ts:5`
- Modify: `src/components/MyFeed.tsx:71-75, 294-309, 443-496`

- [ ] **Step 1: Extend the type**

In `src/types/event.ts`, change line 5 from:

```ts
export type EventViewMode = 'detailed' | 'compact' | 'calendar'
```

to:

```ts
export type EventViewMode = 'detailed' | 'compact' | 'calendar' | 'schedule'
```

- [ ] **Step 2: Update the localStorage hydrator**

In `src/components/MyFeed.tsx`, replace the `useState<EventViewMode>` initialiser (lines 71-75):

```tsx
const [viewMode, setViewMode] = useState<EventViewMode>(() => {
  if (typeof window === 'undefined') return 'schedule'
  const saved = window.localStorage.getItem('timelineViewMode')
  if (saved === 'calendar') return 'calendar'
  if (saved === 'compact') return 'compact'
  if (saved === 'schedule') return 'schedule'
  return 'schedule'  // default for new users (no saved preference)
})
```

- [ ] **Step 3: Persist mode changes to localStorage**

The current code doesn't write the choice back. Add an effect right after the `useState` above:

```tsx
useEffect(() => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('timelineViewMode', viewMode)
}, [viewMode])
```

- [ ] **Step 4: Add the Schedule pill (leftmost)**

In `src/components/MyFeed.tsx` around lines 294-309, replace the two-button pill row with three buttons (Schedule first):

```tsx
<div className="mt-2 inline-flex rounded-md border border-gray-300 bg-white p-0.5">
  <button
    type="button"
    onClick={() => setViewMode('schedule')}
    className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'schedule' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
  >
    Schedule
  </button>
  <button
    type="button"
    onClick={() => setViewMode('compact')}
    className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'compact' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
  >
    Timeline
  </button>
  <button
    type="button"
    onClick={() => setViewMode('calendar')}
    className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'calendar' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
  >
    Calendar
  </button>
</div>
```

- [ ] **Step 5: Stub the Schedule render branch**

Around line 443, where the `viewMode === 'calendar' ? <CalendarGrid /> : <Timeline />` ternary lives, refactor to:

```tsx
{viewMode === 'schedule' ? (
  <div className="text-sm text-gray-500 p-4">Schedule overview coming soon…</div>
) : viewMode === 'calendar' ? (
  <CalendarGrid
    events={filteredEvents}
    preferredVisitDates={preferredVisitDates}
    onDelete={handleDeleteClick}
    onShareSuccess={loadEvents}
    onDataChange={loadEvents}
    onHashtagClick={(tag) => {
      setActiveHashtag(tag)
      setShowPast(true)
    }}
    showActions
  />
) : (
  <>
    {/* existing Timeline branch unchanged */}
  </>
)}
```

- [ ] **Step 6: Manual sanity check**

Run: `npx plannen up` (or your dev process), open the My Plans tab, click the Schedule pill. Expected: pill highlights indigo, body shows "Schedule overview coming soon…". Reload — Schedule pill stays selected (localStorage persisted).

- [ ] **Step 7: Commit**

```bash
git add src/types/event.ts src/components/MyFeed.tsx
git commit -m "feat: add Schedule view-mode pill to My Plans (stub)"
```

---

## Task 2: weatherService

**Files:**
- Create: `src/services/weatherService.ts`
- Create: `src/services/weatherService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/services/weatherService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTodayWeather, _clearWeatherCacheForTest } from './weatherService'

beforeEach(() => {
  vi.restoreAllMocks()
  _clearWeatherCacheForTest()
})

function mockFetchOk(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ))
}

describe('getTodayWeather', () => {
  it('returns parsed weather for Brussels', async () => {
    mockFetchOk({
      city: 'Brussels',
      temp_c: 24,
      summary: 'Clear all day',
      chips: [
        { time: '07:00', label: 'AM clear' },
        { time: '12:00', label: 'noon mild' },
        { time: '18:00', label: 'PM cool' },
      ],
    })
    const w = await getTodayWeather('Brussels')
    expect(w).not.toBeNull()
    expect(w!.temp_c).toBe(24)
    expect(w!.summary).toBe('Clear all day')
    expect(w!.chips).toHaveLength(3)
  })

  it('returns null on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const w = await getTodayWeather('Brussels')
    expect(w).toBeNull()
  })

  it('returns null on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 502 })))
    const w = await getTodayWeather('Brussels')
    expect(w).toBeNull()
  })

  it('caches per (city, day): second call does not refetch', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        city: 'Brussels', temp_c: 20, summary: 'Cloudy', chips: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    vi.stubGlobal('fetch', fetchSpy)
    await getTodayWeather('Brussels')
    await getTodayWeather('Brussels')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/weatherService.test.ts`
Expected: FAIL — `getTodayWeather` not defined.

- [ ] **Step 3: Implement the service**

Create `src/services/weatherService.ts`:

```ts
export interface WeatherChip {
  time: string
  label: string
}

export interface TodayWeather {
  city: string
  temp_c: number
  summary: string
  chips: WeatherChip[]
  fetched_at: string
}

const SESSION_PREFIX = 'plannen:weather:'

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function cacheKey(city: string, day: string): string {
  return `${SESSION_PREFIX}${city.toLowerCase()}:${day}`
}

// In-memory fallback for environments without sessionStorage (tests, SSR).
const memCache = new Map<string, TodayWeather>()

function readCache(key: string): TodayWeather | null {
  if (memCache.has(key)) return memCache.get(key)!
  if (typeof sessionStorage === 'undefined') return null
  const raw = sessionStorage.getItem(key)
  if (!raw) return null
  try { return JSON.parse(raw) as TodayWeather } catch { return null }
}

function writeCache(key: string, value: TodayWeather): void {
  memCache.set(key, value)
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* quota or disabled */ }
  }
}

export function _clearWeatherCacheForTest(): void {
  memCache.clear()
  if (typeof sessionStorage !== 'undefined') {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(SESSION_PREFIX))
      .forEach((k) => sessionStorage.removeItem(k))
  }
}

export async function getTodayWeather(city: string): Promise<TodayWeather | null> {
  const day = ymd(new Date())
  const key = cacheKey(city, day)
  const cached = readCache(key)
  if (cached) return cached

  try {
    const url = `https://www.meteo.be/services/forecast/v0/today?city=${encodeURIComponent(city)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json() as Partial<TodayWeather>
    if (typeof data.temp_c !== 'number' || typeof data.summary !== 'string') return null
    const w: TodayWeather = {
      city: data.city ?? city,
      temp_c: data.temp_c,
      summary: data.summary,
      chips: Array.isArray(data.chips) ? data.chips : [],
      fetched_at: new Date().toISOString(),
    }
    writeCache(key, w)
    return w
  } catch {
    return null
  }
}
```

> Note for implementer: meteo.be does not publish a stable JSON endpoint at the URL above. Treat the URL as a single-line swap point: if the real endpoint differs, change the URL + the parser inside the try block. The contract (`TodayWeather | null`, cache semantics, graceful failure) is what the rest of the UI depends on.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/weatherService.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/weatherService.ts src/services/weatherService.test.ts
git commit -m "feat: weatherService (meteo.be + session cache)"
```

---

## Task 3: ScheduleOverview skeleton

**Files:**
- Create: `src/components/ScheduleOverview.tsx`
- Create: `src/components/ScheduleOverview.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `src/components/ScheduleOverview.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ScheduleOverview } from './ScheduleOverview'
import { Event } from '../types/event'

vi.mock('../hooks/usePrimaryGroup', () => ({
  usePrimaryGroup: () => null,
}))
vi.mock('../services/weatherService', () => ({
  getTodayWeather: vi.fn(async () => null),
}))
vi.mock('../services/practiceService', () => ({
  listPractices: vi.fn(async () => []),
  completionsThisWeek: vi.fn(async () => []),
  markPracticeDone: vi.fn(async () => {}),
  unmarkPracticeDone: vi.fn(async () => {}),
}))

function renderOverview(events: Event[] = []) {
  return render(
    <MemoryRouter>
      <ScheduleOverview
        events={events}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onShareSuccess={vi.fn()}
        onHashtagClick={vi.fn()}
        preferredVisitDates={{}}
      />
    </MemoryRouter>
  )
}

describe('ScheduleOverview', () => {
  it('renders all six section headings', async () => {
    renderOverview([])
    expect(screen.getByText('Your Schedule')).toBeInTheDocument()
    expect(await screen.findByText(/Weather unavailable|°/)).toBeInTheDocument()
    expect(screen.getByText('Routines')).toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('This week')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL — `ScheduleOverview` not found.

- [ ] **Step 3: Implement the skeleton**

Create `src/components/ScheduleOverview.tsx`:

```tsx
import { Event } from '../types/event'

export interface ScheduleOverviewProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
  onEdit: (event: Event) => void
  onDelete: (id: string) => void
  onShareSuccess: () => void
  onHashtagClick: (tag: string) => void
}

export function ScheduleOverview(_props: ScheduleOverviewProps) {
  return (
    <div className="space-y-4 w-full min-w-0">
      <HeaderStrip />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <WeatherCard />
        <RoutinesCard />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TodayCard />
        <ThisWeekCard />
      </div>
      <ThisMonthCard />
    </div>
  )
}

function HeaderStrip() {
  return (
    <header className="flex items-baseline justify-between">
      <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">Your Schedule</h2>
    </header>
  )
}

function WeatherCard() {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-sm text-gray-500">Weather unavailable</div>
    </section>
  )
}

function RoutinesCard() {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Routines</h3>
    </section>
  )
}

function TodayCard() {
  return (
    <section className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Today</h3>
    </section>
  )
}

function ThisWeekCard() {
  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">This week</h3>
    </section>
  )
}

function ThisMonthCard() {
  return (
    <section className="rounded-lg border border-violet-200 bg-violet-50 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">This month</h3>
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS — all six headings visible.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat: ScheduleOverview skeleton with six panels"
```

---

## Task 4: Header strip + family tag

**Files:**
- Modify: `src/components/ScheduleOverview.tsx` — `HeaderStrip`

- [ ] **Step 1: Extend the test**

Add to `src/components/ScheduleOverview.test.tsx` inside `describe('ScheduleOverview', …)`:

```tsx
it('renders the date and omits the family tag when no primary group', async () => {
  renderOverview([])
  // Date string format: "Mon, Jan 1" — assert the weekday short prefix exists
  expect(screen.getByText(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s/)).toBeInTheDocument()
  expect(screen.queryByText(/for the .* family/)).not.toBeInTheDocument()
})

it('renders the family tag when a primary group exists', async () => {
  // Re-mock just for this test
  const { usePrimaryGroup } = await import('../hooks/usePrimaryGroup')
  vi.mocked(usePrimaryGroup).mockReturnValueOnce({ id: 'g1', name: 'Patel' } as any)
  renderOverview([])
  expect(screen.getByText(/for the Patel family/)).toBeInTheDocument()
})
```

Also adjust the top-of-file mock so the hook can be re-mocked per-test:

```tsx
vi.mock('../hooks/usePrimaryGroup', () => ({
  usePrimaryGroup: vi.fn(() => null),
}))
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL on the two new tests — date and family tag not rendered yet.

- [ ] **Step 3: Implement the header**

In `src/components/ScheduleOverview.tsx`, replace `HeaderStrip` with:

```tsx
import { usePrimaryGroup } from '../hooks/usePrimaryGroup'

function HeaderStrip() {
  const primaryGroup = usePrimaryGroup()
  const today = new Date()
  const dateLabel = today.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  })
  return (
    <header className="flex items-baseline justify-between">
      <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">Your Schedule</h2>
      <div className="text-right">
        <div className="text-sm text-gray-700">{dateLabel}</div>
        {primaryGroup && (
          <div className="text-xs text-gray-500">for the {primaryGroup.name} family</div>
        )}
      </div>
    </header>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS — all four tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat: ScheduleOverview header + family tag"
```

---

## Task 5: Weather card

**Files:**
- Modify: `src/components/ScheduleOverview.tsx` — `WeatherCard` + city resolution

- [ ] **Step 1: Extend the test**

In `src/components/ScheduleOverview.test.tsx` add:

```tsx
it('renders weather chips when service returns data', async () => {
  const { getTodayWeather } = await import('../services/weatherService')
  vi.mocked(getTodayWeather).mockResolvedValueOnce({
    city: 'Brussels',
    temp_c: 24,
    summary: 'Clear all day',
    chips: [
      { time: '07:00', label: 'AM clear' },
      { time: '12:00', label: 'noon mild' },
      { time: '18:00', label: 'PM cool' },
    ],
    fetched_at: new Date().toISOString(),
  })
  renderOverview([])
  expect(await screen.findByText(/24°/)).toBeInTheDocument()
  expect(screen.getByText('Clear all day')).toBeInTheDocument()
  expect(screen.getByText('AM clear')).toBeInTheDocument()
})
```

Also at the top of file ensure `getTodayWeather` is mocked as `vi.fn(async () => null)` (it already is from Task 3 — confirm).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL — the 24° + chips assertions fail.

- [ ] **Step 3: Implement the card**

In `src/components/ScheduleOverview.tsx`, add imports and replace `WeatherCard`:

```tsx
import { useEffect, useState } from 'react'
import { getTodayWeather, TodayWeather } from '../services/weatherService'

function WeatherCard({ city }: { city: string }) {
  const [weather, setWeather] = useState<TodayWeather | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    void getTodayWeather(city).then((w) => {
      if (!cancelled) {
        setWeather(w)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [city])

  if (loading) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm text-gray-400">Loading weather…</div>
      </section>
    )
  }
  if (!weather) {
    return (
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm text-gray-500">Weather unavailable</div>
      </section>
    )
  }
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-baseline gap-3">
        <div className="text-3xl font-semibold text-gray-900">{Math.round(weather.temp_c)}°</div>
        <div className="text-sm text-gray-700">{weather.summary}</div>
      </div>
      {weather.chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-600">
          {weather.chips.map((c) => (
            <span key={c.time} className="rounded bg-gray-100 px-2 py-0.5">
              {c.label}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
```

Update the parent `ScheduleOverview` to pass `city`:

```tsx
import { usePrimaryGroup } from '../hooks/usePrimaryGroup'

export function ScheduleOverview(props: ScheduleOverviewProps) {
  const primaryGroup = usePrimaryGroup()
  const city = primaryGroup?.location ?? 'Brussels'
  return (
    <div className="space-y-4 w-full min-w-0">
      <HeaderStrip />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <WeatherCard city={city} />
        <RoutinesCard />
      </div>
      {/* … rest unchanged … */}
    </div>
  )
}
```

> Note for implementer: if `usePrimaryGroup` doesn't currently expose a `location` field, drop the `primaryGroup?.location ?? ` part and pass `'Brussels'` directly. Per-user weather location is explicitly out of scope (see spec) — do NOT extend the group shape or add a settings field in this plan.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS — weather card renders 24° + chips.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat: ScheduleOverview weather card"
```

---

## Task 6: Routines card (interactive)

**Files:**
- Modify: `src/components/ScheduleOverview.tsx` — `RoutinesCard`

- [ ] **Step 1: Extend the test**

In `src/components/ScheduleOverview.test.tsx` add:

```tsx
it('lists practices and toggles completion', async () => {
  const { listPractices, completionsThisWeek, markPracticeDone } =
    await import('../services/practiceService')
  vi.mocked(listPractices).mockResolvedValueOnce([
    { id: 'p1', name: 'Sunscreen before drop-off', frequency_type: 'daily', target_count: null } as any,
    { id: 'p2', name: 'Gym',                       frequency_type: 'weekly_count', target_count: 3 } as any,
  ])
  vi.mocked(completionsThisWeek).mockResolvedValueOnce([])
  renderOverview([])
  expect(await screen.findByText(/Sunscreen before drop-off/)).toBeInTheDocument()
  expect(screen.getByText(/Gym \(0\/3 this week\)/)).toBeInTheDocument()

  // Click the first checkbox
  const cb = screen.getAllByRole('checkbox')[0]
  cb.click()
  expect(vi.mocked(markPracticeDone)).toHaveBeenCalledWith('p1', expect.any(String))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL — no practices rendered.

- [ ] **Step 3: Implement the card**

In `src/components/ScheduleOverview.tsx`, add:

```tsx
import {
  listPractices, completionsThisWeek, markPracticeDone, unmarkPracticeDone,
} from '../services/practiceService'
import type { PracticeRow, PracticeCompletionRow } from '../lib/dbClient/types'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function weekStartIso(): string {
  const d = new Date()
  const js = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (js - 1))
  return d.toISOString().slice(0, 10)
}

function RoutinesCard() {
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [completions, setCompletions] = useState<PracticeCompletionRow[]>([])
  const [loading, setLoading] = useState(true)
  const date = todayIso()

  const refresh = async () => {
    const [p, c] = await Promise.all([
      listPractices(true),
      completionsThisWeek(weekStartIso()),
    ])
    setPractices(p)
    setCompletions(c)
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  const isDoneToday = (id: string) =>
    completions.some((c) => c.practice_id === id && c.completed_on === date)

  const toggle = async (p: PracticeRow) => {
    if (isDoneToday(p.id)) await unmarkPracticeDone(p.id, date)
    else await markPracticeDone(p.id, date)
    await refresh()
  }

  const visible = practices.slice(0, 6)
  const overflow = practices.length - visible.length

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Routines</h3>
      {loading ? (
        <div className="text-xs text-gray-400">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="text-xs text-gray-500">No routines defined.</div>
      ) : (
        <ul className="space-y-1">
          {visible.map((p) => {
            const done = isDoneToday(p.id)
            const weekDone = completions.filter((c) => c.practice_id === p.id).length
            const label = p.frequency_type === 'weekly_count'
              ? `${p.name} (${weekDone}/${p.target_count ?? 0} this week)`
              : p.frequency_type === 'daily' ? `${p.name} (daily)` : p.name
            return (
              <li key={p.id}>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={() => void toggle(p)}
                    className="h-4 w-4"
                  />
                  <span className={done ? 'line-through text-gray-400' : 'text-gray-800'}>
                    {label}
                  </span>
                </label>
              </li>
            )
          })}
          {overflow > 0 && (
            <li className="text-xs text-indigo-600">+{overflow} more in Routines</li>
          )}
        </ul>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS — practices listed and `markPracticeDone` called with `'p1'`.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat: ScheduleOverview routines card (interactive)"
```

---

## Task 7: Today + This week cards

**Files:**
- Modify: `src/components/ScheduleOverview.tsx` — `TodayCard`, `ThisWeekCard`
- Create: small inline date helpers within the same file (do NOT extract to a shared util — YAGNI; promote later if a third caller appears).

- [ ] **Step 1: Extend the test**

Append to `src/components/ScheduleOverview.test.tsx`:

```tsx
function makeEvent(overrides: Partial<Event>): Event {
  const today = new Date().toISOString().slice(0, 10)
  return {
    id: overrides.id ?? 'e1',
    title: 'Untitled',
    description: null,
    start_date: today,
    end_date: null,
    enrollment_url: null,
    enrollment_deadline: null,
    enrollment_start_date: null,
    image_url: null,
    location: null,
    hashtags: null,
    event_kind: 'event',
    event_type: 'personal',
    event_status: 'going',
    created_by: 'u1',
    created_at: today,
    updated_at: today,
    shared_with_friends: 'none',
    ...overrides,
  } as Event
}

it('renders today events in the Today card', () => {
  renderOverview([
    makeEvent({ id: 'e1', title: 'Sync with Priya', start_date: new Date().toISOString().slice(0, 10) }),
  ])
  expect(screen.getByText('Sync with Priya')).toBeInTheDocument()
})

it('renders week events as chips on the right day', () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const tomorrow = d.toISOString().slice(0, 10)
  renderOverview([makeEvent({ id: 'e2', title: 'Dentist', start_date: tomorrow })])
  expect(screen.getByText('Dentist')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL — event titles not rendered.

- [ ] **Step 3: Implement the cards**

In `src/components/ScheduleOverview.tsx`, add helpers and replace the two cards:

```tsx
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isToday(event: Event): boolean {
  const today = ymd(new Date())
  const start = event.start_date.slice(0, 10)
  const end = (event.end_date ?? event.start_date).slice(0, 10)
  return start <= today && end >= today
}

function weekWindow(): { start: Date; days: Date[] } {
  const now = new Date()
  const dow = now.getDay() || 7  // Mon = 1, Sun = 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dow - 1))
  monday.setHours(0, 0, 0, 0)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
  return { start: monday, days }
}

function intersectsDay(event: Event, day: Date): boolean {
  const dayIso = ymd(day)
  const start = event.start_date.slice(0, 10)
  const end = (event.end_date ?? event.start_date).slice(0, 10)
  return start <= dayIso && end >= dayIso
}

function timeOf(event: Event): string {
  const t = new Date(event.start_date)
  if (Number.isNaN(t.getTime())) return ''
  if (event.start_date.length <= 10) return ''  // date-only
  return t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function TodayCard({ events, onEdit }: { events: Event[]; onEdit: (e: Event) => void }) {
  const todays = events.filter(isToday).slice().sort((a, b) => a.start_date.localeCompare(b.start_date))
  return (
    <section className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">Today</h3>
      {todays.length === 0 ? (
        <div className="text-xs text-gray-500">Nothing scheduled — enjoy the day.</div>
      ) : (
        <ul className="space-y-1">
          {todays.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onEdit(e)}
                className="w-full text-left text-sm text-gray-800 hover:text-indigo-700"
              >
                <span className="text-gray-500 mr-2">{timeOf(e)}</span>
                {e.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ThisWeekCard({ events, onEdit }: { events: Event[]; onEdit: (e: Event) => void }) {
  const { days } = weekWindow()
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const todayIso = ymd(new Date())
  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">This week</h3>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day, idx) => {
          const iso = ymd(day)
          const dayEvents = events.filter((e) => intersectsDay(e, day))
          const visible = dayEvents.slice(0, 3)
          const overflow = dayEvents.length - visible.length
          return (
            <div
              key={iso}
              className={`min-h-[80px] rounded p-1 text-[10px] ${iso === todayIso ? 'bg-emerald-100' : 'bg-white'}`}
            >
              <div className="font-medium text-gray-600">{dayLabels[idx]} {day.getDate()}</div>
              <div className="mt-1 space-y-0.5">
                {visible.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onEdit(e)}
                    className="block w-full truncate text-left rounded bg-emerald-200/60 px-1 hover:bg-emerald-300/60"
                    aria-label={`${e.title} on ${iso}`}
                  >
                    {e.title}
                  </button>
                ))}
                {overflow > 0 && <div className="text-gray-500">+{overflow}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

Update parent to pass props:

```tsx
<TodayCard events={props.events} onEdit={props.onEdit} />
<ThisWeekCard events={props.events} onEdit={props.onEdit} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS — Sync with Priya and Dentist both rendered.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat: ScheduleOverview today + week cards"
```

---

## Task 8: This month card

**Files:**
- Modify: `src/components/ScheduleOverview.tsx` — `ThisMonthCard`

- [ ] **Step 1: Extend the test**

Append to `src/components/ScheduleOverview.test.tsx`:

```tsx
it('lists notable events (reminders + with enrollment_deadline) in month sidebar', () => {
  const today = new Date()
  const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  renderOverview([
    makeEvent({ id: 'r1', title: 'Renew passport', event_kind: 'reminder', start_date: `${thisMonth}-15` }),
    makeEvent({ id: 'e3', title: 'Camp deadline', start_date: `${thisMonth}-20`, enrollment_deadline: `${thisMonth}-25` }),
  ])
  expect(screen.getByText('Renew passport')).toBeInTheDocument()
  expect(screen.getByText('Camp deadline')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: FAIL — notable events not rendered.

- [ ] **Step 3: Implement the card**

In `src/components/ScheduleOverview.tsx`, replace `ThisMonthCard`:

```tsx
import { CalendarGrid } from './CalendarGrid'

function isInCurrentMonth(iso: string | null): boolean {
  if (!iso) return false
  const now = new Date()
  return iso.slice(0, 7) === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function isNotable(event: Event): boolean {
  if (event.event_kind === 'reminder' && isInCurrentMonth(event.start_date)) return true
  if (isInCurrentMonth(event.enrollment_deadline)) return true
  return false
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(5, 10)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface ThisMonthCardProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
  onDelete: (id: string) => void
  onShareSuccess: () => void
  onHashtagClick: (tag: string) => void
  onEdit: (event: Event) => void
}

function ThisMonthCard({ events, preferredVisitDates, onDelete, onShareSuccess, onHashtagClick, onEdit }: ThisMonthCardProps) {
  const notable = events
    .filter(isNotable)
    .slice()
    .sort((a, b) => {
      const ad = a.enrollment_deadline ?? a.start_date
      const bd = b.enrollment_deadline ?? b.start_date
      return ad.localeCompare(bd)
    })
  return (
    <section className="rounded-lg border border-violet-200 bg-violet-50 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">This month</h3>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
        <div className="min-w-0">
          <CalendarGrid
            events={events}
            preferredVisitDates={preferredVisitDates}
            onDelete={onDelete}
            onShareSuccess={onShareSuccess}
            onDataChange={onShareSuccess}
            onHashtagClick={onHashtagClick}
            showActions={false}
          />
        </div>
        <aside className="space-y-1">
          {notable.length === 0 ? (
            <div className="text-xs text-gray-500">No deadlines or reminders this month.</div>
          ) : notable.map((e) => {
            const date = e.enrollment_deadline ?? e.start_date
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onEdit(e)}
                className="block w-full text-left text-xs text-gray-800 hover:text-indigo-700"
              >
                <span className="text-gray-500 mr-2">{formatShortDate(date)}</span>
                {e.title}
              </button>
            )
          })}
        </aside>
      </div>
    </section>
  )
}
```

Update parent dispatch:

```tsx
<ThisMonthCard
  events={props.events}
  preferredVisitDates={props.preferredVisitDates}
  onDelete={props.onDelete}
  onShareSuccess={props.onShareSuccess}
  onHashtagClick={props.onHashtagClick}
  onEdit={props.onEdit}
/>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS — notable list shows both items.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat: ScheduleOverview month card with notable sidebar"
```

---

## Task 9: Wire ScheduleOverview into MyFeed

**Files:**
- Modify: `src/components/MyFeed.tsx` — replace the Schedule stub with the real component.

- [ ] **Step 1: Replace the stub branch**

In `src/components/MyFeed.tsx`, replace the `viewMode === 'schedule'` placeholder added in Task 1 with:

```tsx
{viewMode === 'schedule' ? (
  <ScheduleOverview
    events={filteredEvents}
    preferredVisitDates={preferredVisitDates}
    onEdit={handleEdit}
    onDelete={handleDeleteClick}
    onShareSuccess={loadEvents}
    onHashtagClick={(tag) => {
      setActiveHashtag(tag)
      setShowPast(true)
    }}
  />
) : viewMode === 'calendar' ? (
  /* … unchanged … */
) : (
  /* … unchanged Timeline branch … */
)}
```

Add the import at the top of the file (alphabetically with the other component imports):

```tsx
import { ScheduleOverview } from './ScheduleOverview'
```

- [ ] **Step 2: Type-check the build**

Run: `npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests + new tests green.

- [ ] **Step 4: Manual verification in the browser**

Per CLAUDE.md ("For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete"):

1. `npx plannen up`
2. Open http://localhost:4321 → log in → My Plans.
3. Click the Schedule pill.
4. Verify each panel: header date + family tag, weather card (real or "unavailable"), routines list with working checkboxes, Today events for today, This-week grid with current day highlighted, This-month CalendarGrid + notable sidebar.
5. Click an event chip → existing EventForm modal opens for edit.
6. Reload the page — Schedule remains the active pill (localStorage).
7. Switch to Timeline, then Calendar, then back to Schedule — all three work.

- [ ] **Step 5: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: wire ScheduleOverview into My Plans"
```

---

## Self-review notes (for the implementer's reference)

- **Spec coverage:** Tasks 1–9 cover every section listed in the spec (header, weather, routines, today, week, month) plus the wiring. The "no new event queries" constraint holds — Tasks 7/8 only filter `props.events`.
- **Types:** `WeatherChip` / `TodayWeather` defined in Task 2 are the only new shapes; everything else is reused (`Event`, `PracticeRow`, `PracticeCompletionRow`).
- **Naming:** `getTodayWeather` used consistently in service + tests + component.
- **Out of scope confirmed:** no per-user weather location setting, no DB/edge/MCP changes, no migrations, no default-view promotion.
- **Rollback:** revert Tasks 1 and 9 — the new files become dead code with zero runtime touch.
