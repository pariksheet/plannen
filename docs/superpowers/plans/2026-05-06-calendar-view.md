# Calendar View Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone "My Calendar" nav tab with a Calendar view mode in My Feed (Compact | Detailed | Calendar), fix the session rendering bug, and delete the old MyCalendar component.

**Architecture:** Extract `MyCalendar.tsx` into a props-driven `CalendarGrid.tsx` that receives filtered events from MyFeed. MyFeed renders CalendarGrid when viewMode='calendar', passing its already-filtered events so all filter pills apply automatically. The My Calendar nav tab and `MyCalendar.tsx` are deleted.

**Tech Stack:** React, TypeScript, Tailwind CSS, date-fns, lucide-react

---

### Task 1: Add 'calendar' to EventViewMode

**Files:**
- Modify: `src/types/event.ts:5`

- [ ] **Step 1: Update EventViewMode type**

Old line 5:
```ts
export type EventViewMode = 'detailed' | 'compact'
```

New line 5:
```ts
export type EventViewMode = 'detailed' | 'compact' | 'calendar'
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: No errors (nothing yet uses 'calendar' so no downstream breakage).

- [ ] **Step 3: Commit**

```bash
git add src/types/event.ts
git commit -m "feat: add 'calendar' to EventViewMode type"
```

---

### Task 2: Create CalendarGrid component

**Files:**
- Create: `src/components/CalendarGrid.tsx`

This is the calendar grid extracted from `MyCalendar.tsx` with two changes:
1. No data fetching — receives `events` and `preferredVisitDates` as props
2. Session bug fix in `eventsByDay`: parent recurring events are skipped when child sessions exist; sessions always plot on `start_date` only

- [ ] **Step 1: Create `src/components/CalendarGrid.tsx`**

```tsx
import { useMemo, useState } from 'react'
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from 'date-fns'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { Event, EventFormData } from '../types/event'
import { EventList } from './EventList'
import { EventDetailsModal } from './EventDetailsModal'
import { EventForm } from './EventForm'

interface CalendarGridProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
  onDelete?: (eventId: string) => void
  onShareSuccess?: () => void
  onDataChange?: () => void
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function CalendarGrid({ events, preferredVisitDates, onDelete, onShareSuccess, onDataChange }: CalendarGridProps) {
  const [currentMonth, setCurrentMonth] = useState<Date>(startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState<Date>(new Date())
  const [focusedEvent, setFocusedEvent] = useState<Event | null>(null)
  const [rsvpVersion, setRsvpVersion] = useState(0)
  const [calendarView, setCalendarView] = useState<'monthly' | 'weekly'>('monthly')
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)

  const currentYear = new Date().getFullYear()
  const yearOptions = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i)
  const monthOptions = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]

  const openCreateForDay = (day: Date) => {
    setEditingEvent(undefined)
    const draft = new Date(day)
    draft.setHours(9, 0, 0, 0)
    setInitialFormData({
      start_date: draft.toISOString(),
      end_date: '',
      event_kind: 'event',
      event_type: 'personal',
      shared_with_family: false,
      shared_with_friends: 'none',
      shared_with_user_ids: [],
      shared_with_group_ids: [],
      hashtags: [],
    })
    setShowForm(true)
  }

  const handleEdit = (event: Event) => {
    setInitialFormData(null)
    setEditingEvent(event)
    setShowForm(true)
  }

  const eventsByDay = useMemo(() => {
    // Skip parent recurring events that have child sessions in this events array
    const parentIds = new Set(
      events.filter(e => e.parent_event_id).map(e => e.parent_event_id!)
    )

    const byDay = new Map<string, Event[]>()
    for (const event of events) {
      if (parentIds.has(event.id)) continue

      const preferredVisitDate = preferredVisitDates[event.id]
      if (preferredVisitDate) {
        const key = toDateKey(startOfDay(new Date(preferredVisitDate)))
        const current = byDay.get(key) ?? []
        current.push(event)
        byDay.set(key, current)
        continue
      }

      const start = startOfDay(new Date(event.start_date))
      // Sessions are always single-day; regular events may span multiple days
      const hasRange = event.event_kind !== 'session' &&
        !!event.end_date &&
        new Date(event.end_date).getTime() > new Date(event.start_date).getTime()

      if (!hasRange) {
        const key = toDateKey(start)
        const current = byDay.get(key) ?? []
        current.push(event)
        byDay.set(key, current)
        continue
      }

      const end = startOfDay(new Date(event.end_date!))
      for (let d = new Date(start.getTime()); d <= end; d = addDays(d, 1)) {
        const key = toDateKey(d)
        const current = byDay.get(key) ?? []
        current.push(event)
        byDay.set(key, current)
      }
    }
    return byDay
  }, [events, preferredVisitDates])

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const weekStart = startOfWeek(currentMonth, { weekStartsOn: 1 })
  const weekEnd = endOfWeek(currentMonth, { weekStartsOn: 1 })
  const gridStart = calendarView === 'monthly' ? startOfWeek(monthStart, { weekStartsOn: 1 }) : weekStart
  const gridEnd = calendarView === 'monthly' ? endOfWeek(monthEnd, { weekStartsOn: 1 }) : weekEnd
  const days: Date[] = []
  for (let d = new Date(gridStart.getTime()); d <= gridEnd; d = addDays(d, 1)) {
    days.push(new Date(d.getTime()))
  }

  const selectedKey = toDateKey(selectedDate)
  const selectedEvents = (eventsByDay.get(selectedKey) ?? [])
    .slice()
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5">
        <button
          type="button"
          onClick={() => setCalendarView('monthly')}
          className={`px-3 py-1 text-xs font-medium rounded ${calendarView === 'monthly' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setCalendarView('weekly')}
          className={`px-3 py-1 text-xs font-medium rounded ${calendarView === 'weekly' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
        >
          Weekly
        </button>
      </div>

      <div className="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] gap-4 items-start">
        <div className="bg-white rounded-lg border border-gray-200 p-4 w-full">
          <div className="flex items-center justify-between mb-4">
            <button
              type="button"
              onClick={() => setCurrentMonth((prev) => calendarView === 'monthly' ? subMonths(prev, 1) : subWeeks(prev, 1))}
              className="inline-flex items-center justify-center w-10 h-10 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
              aria-label="Previous"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2">
              <select
                value={currentMonth.getMonth()}
                onChange={(e) => {
                  const nextMonth = Number(e.target.value)
                  setCurrentMonth((prev) => new Date(prev.getFullYear(), nextMonth, 1))
                }}
                className="h-10 rounded-md border border-gray-300 bg-white px-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Select month"
              >
                {monthOptions.map((month, index) => (
                  <option key={month} value={index}>{month}</option>
                ))}
              </select>
              <select
                value={currentMonth.getFullYear()}
                onChange={(e) => {
                  const nextYear = Number(e.target.value)
                  setCurrentMonth((prev) => new Date(nextYear, prev.getMonth(), 1))
                }}
                className="h-10 rounded-md border border-gray-300 bg-white px-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Select year"
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => setCurrentMonth((prev) => calendarView === 'monthly' ? addMonths(prev, 1) : addWeeks(prev, 1))}
              className="inline-flex items-center justify-center w-10 h-10 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
              aria-label="Next"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-gray-500 mb-2">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
              <div key={label} className="py-1">{label}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const key = toDateKey(day)
              const dayEvents = eventsByDay.get(key) ?? []
              const inMonth = isSameMonth(day, currentMonth)
              const isSelected = isSameDay(day, selectedDate)
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedDate(day)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedDate(day) }}
                  className={`text-left rounded-md border p-1.5 transition-colors ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-50'
                      : isToday(day)
                        ? 'border-emerald-300 bg-emerald-50'
                        : inMonth
                          ? 'border-gray-200 bg-white hover:bg-gray-50'
                          : 'border-gray-100 bg-gray-50 text-gray-400'
                  } ${calendarView === 'monthly' ? 'min-h-[90px]' : 'min-h-[130px]'}`}
                >
                  <div className="w-full flex items-center justify-between">
                    <span className={`text-xs font-medium ${isToday(day) ? 'text-indigo-700' : ''}`}>
                      {format(day, 'd')}
                    </span>
                    <div className="flex items-center gap-1">
                      {dayEvents.length > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-semibold">
                          {dayEvents.length}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openCreateForDay(day) }}
                        className="inline-flex items-center justify-center w-5 h-5 rounded border border-gray-200 text-gray-500 hover:text-indigo-700 hover:border-indigo-300 hover:bg-white/80"
                        aria-label={`Add event on ${format(day, 'MMMM d, yyyy')}`}
                        title="Add event"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 min-h-[1.25rem] space-y-0.5 overflow-visible">
                    {dayEvents.slice(0, calendarView === 'monthly' ? 2 : 6).map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setFocusedEvent(event) }}
                        className="block w-full min-w-0 text-left text-[10px] leading-tight text-gray-700 truncate hover:text-indigo-700 hover:underline"
                      >
                        {event.title}
                      </button>
                    ))}
                    {calendarView === 'monthly' && dayEvents.length > 2 && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setSelectedDate(day) }}
                        className="block w-full text-left text-[10px] leading-tight text-indigo-600 hover:underline"
                      >
                        +{dayEvents.length - 2} more
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-24">
          <div className="bg-white rounded-lg border border-gray-200 p-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-gray-700">
                {format(selectedDate, 'EEEE, MMM d, yyyy')}
              </h4>
              <button
                type="button"
                onClick={() => openCreateForDay(selectedDate)}
                className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              >
                <Plus className="h-3.5 w-3.5" />
                Add event
              </button>
            </div>
          </div>
          {selectedEvents.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-lg border border-gray-200">
              <p className="text-gray-500 text-sm">No events on this day.</p>
            </div>
          ) : (
            <EventList
              events={selectedEvents}
              onEdit={handleEdit}
              onDelete={onDelete}
              onShareSuccess={onShareSuccess}
              showRSVP
              showMemories
              showWatchButton={false}
              viewMode="compact"
            />
          )}
        </aside>
      </div>

      {focusedEvent && (
        <EventDetailsModal
          event={focusedEvent}
          isOpen={!!focusedEvent}
          onClose={() => setFocusedEvent(null)}
          showRSVP
          showMemories
          rsvpVersion={rsvpVersion}
          onRsvpVersionChange={() => setRsvpVersion((v) => v + 1)}
        />
      )}

      {showForm && (
        <EventForm
          event={editingEvent}
          initialData={editingEvent ? undefined : initialFormData ?? undefined}
          onClose={() => {
            setShowForm(false)
            setEditingEvent(undefined)
            setInitialFormData(null)
          }}
          onSuccess={() => {
            setShowForm(false)
            setEditingEvent(undefined)
            setInitialFormData(null)
            onDataChange?.()
          }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/CalendarGrid.tsx
git commit -m "feat: add CalendarGrid component with session fix"
```

---

### Task 3: Add Calendar view mode to MyFeed

**Files:**
- Modify: `src/components/MyFeed.tsx`

Three changes: (1) import CalendarGrid, (2) fix localStorage init, (3) add Calendar button, (4) render CalendarGrid when viewMode='calendar'.

- [ ] **Step 1: Add CalendarGrid import**

Old line 7:
```ts
import { Timeline } from './Timeline'
```

New:
```ts
import { Timeline } from './Timeline'
import { CalendarGrid } from './CalendarGrid'
```

- [ ] **Step 2: Fix localStorage initialiser to accept 'calendar'**

Old (lines 48-52):
```ts
  const [viewMode, setViewMode] = useState<EventViewMode>(() => {
    if (typeof window === 'undefined') return 'compact'
    const saved = window.localStorage.getItem('timelineViewMode')
    return saved === 'detailed' ? 'detailed' : 'compact'
  })
```

New:
```ts
  const [viewMode, setViewMode] = useState<EventViewMode>(() => {
    if (typeof window === 'undefined') return 'compact'
    const saved = window.localStorage.getItem('timelineViewMode')
    return saved === 'detailed' ? 'detailed' : saved === 'calendar' ? 'calendar' : 'compact'
  })
```

- [ ] **Step 3: Add Calendar button to the view toggle**

Old (lines 149-164):
```tsx
          <div className="mt-2 inline-flex rounded-md border border-gray-300 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('compact')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'compact' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => setViewMode('detailed')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'detailed' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Detailed
            </button>
          </div>
```

New:
```tsx
          <div className="mt-2 inline-flex rounded-md border border-gray-300 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('compact')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'compact' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => setViewMode('detailed')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'detailed' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Detailed
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

- [ ] **Step 4: Replace the past + timeline section with a calendar/timeline conditional**

Old (lines 250-331):
```tsx
      ) : (
        <div className="space-y-8">
          {activeHashtag && (
            <div className="w-full max-w-2xl mx-auto flex items-center justify-between gap-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2">
              <p className="text-sm text-indigo-800">
                Filtering by <span className="font-semibold">#{activeHashtag}</span>
              </p>
              <button
                type="button"
                onClick={() => setActiveHashtag(null)}
                className="text-xs font-medium text-indigo-700 hover:text-indigo-900"
              >
                Clear
              </button>
            </div>
          )}

          {showPast && past.length > 0 && (
            <section ref={pastSectionRef}>
              <EventList
                events={visiblePast}
                onEdit={handleEdit}
                onDelete={handleDeleteClick}
                onShareSuccess={loadEvents}
                onHashtagClick={(tag) => {
                  setActiveHashtag(tag)
                  setShowPast(true)
                }}
                showActions
                showRSVP
                showMemories
                viewMode={viewMode}
              />
              {!activeHashtag && pastVisibleCount < past.length && (
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setPastVisibleCount((count) => count + 5)}
                    className="text-xs font-medium text-indigo-700 hover:text-indigo-900 px-3 py-1.5 rounded-full bg-indigo-50 hover:bg-indigo-100"
                  >
                    Show more past events
                  </button>
                </div>
              )}
            </section>
          )}
          <section>
            <div className="w-full max-w-2xl mx-auto min-w-0 mb-2 flex justify-start">
              {past.length > 0 && !showPast && (
                <button
                  type="button"
                  onClick={() => {
                    setShowPast(true)
                    setTimeout(() => {
                      pastSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }, 0)
                  }}
                  className="inline-flex items-center text-xs text-gray-500 hover:text-gray-700"
                >
                  <ChevronUp className="h-3 w-3 mr-1" />
                  Earlier
                </button>
              )}
            </div>
            <Timeline
              items={futureTimeline}
              onEdit={handleEdit}
              onDelete={handleDeleteClick}
              onShareSuccess={loadEvents}
              onHashtagClick={(tag) => {
                setActiveHashtag(tag)
                setShowPast(true)
              }}
              showActions
              showRSVP
              showMemories
              showWatchButton={false}
              viewMode={viewMode}
              emptyMessage={timelineEmptyMessage}
            />
          </section>
        </div>
      )}
```

New:
```tsx
      ) : (
        <div className="space-y-8">
          {activeHashtag && (
            <div className="w-full max-w-2xl mx-auto flex items-center justify-between gap-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2">
              <p className="text-sm text-indigo-800">
                Filtering by <span className="font-semibold">#{activeHashtag}</span>
              </p>
              <button
                type="button"
                onClick={() => setActiveHashtag(null)}
                className="text-xs font-medium text-indigo-700 hover:text-indigo-900"
              >
                Clear
              </button>
            </div>
          )}

          {viewMode === 'calendar' ? (
            <CalendarGrid
              events={filteredEvents}
              preferredVisitDates={preferredVisitDates}
              onDelete={handleDeleteClick}
              onShareSuccess={loadEvents}
              onDataChange={loadEvents}
            />
          ) : (
            <>
              {showPast && past.length > 0 && (
                <section ref={pastSectionRef}>
                  <EventList
                    events={visiblePast}
                    onEdit={handleEdit}
                    onDelete={handleDeleteClick}
                    onShareSuccess={loadEvents}
                    onHashtagClick={(tag) => {
                      setActiveHashtag(tag)
                      setShowPast(true)
                    }}
                    showActions
                    showRSVP
                    showMemories
                    viewMode={viewMode}
                  />
                  {!activeHashtag && pastVisibleCount < past.length && (
                    <div className="mt-3 flex justify-center">
                      <button
                        type="button"
                        onClick={() => setPastVisibleCount((count) => count + 5)}
                        className="text-xs font-medium text-indigo-700 hover:text-indigo-900 px-3 py-1.5 rounded-full bg-indigo-50 hover:bg-indigo-100"
                      >
                        Show more past events
                      </button>
                    </div>
                  )}
                </section>
              )}
              <section>
                <div className="w-full max-w-2xl mx-auto min-w-0 mb-2 flex justify-start">
                  {past.length > 0 && !showPast && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowPast(true)
                        setTimeout(() => {
                          pastSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }, 0)
                      }}
                      className="inline-flex items-center text-xs text-gray-500 hover:text-gray-700"
                    >
                      <ChevronUp className="h-3 w-3 mr-1" />
                      Earlier
                    </button>
                  )}
                </div>
                <Timeline
                  items={futureTimeline}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                  onShareSuccess={loadEvents}
                  onHashtagClick={(tag) => {
                    setActiveHashtag(tag)
                    setShowPast(true)
                  }}
                  showActions
                  showRSVP
                  showMemories
                  showWatchButton={false}
                  viewMode={viewMode}
                  emptyMessage={timelineEmptyMessage}
                />
              </section>
            </>
          )}
        </div>
      )}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat: add Calendar view mode to My Feed"
```

---

### Task 4: Remove My Calendar nav tab and delete MyCalendar.tsx

**Files:**
- Modify: `src/components/Navigation.tsx`
- Modify: `src/pages/Dashboard.tsx`
- Delete: `src/components/MyCalendar.tsx`

- [ ] **Step 1: Remove calendar from Navigation.tsx**

Old line 3 (import):
```ts
import { Menu, X, LogOut, LayoutDashboard, Users, Handshake, UsersRound, CalendarDays, Shield, Settings, UserCircle } from 'lucide-react'
```

New:
```ts
import { Menu, X, LogOut, LayoutDashboard, Users, Handshake, UsersRound, Shield, Settings, UserCircle } from 'lucide-react'
```

Old line 7 (View type):
```ts
type View = 'feed' | 'calendar' | 'family' | 'friends' | 'groups' | 'settings'
```

New:
```ts
type View = 'feed' | 'family' | 'friends' | 'groups' | 'settings'
```

Old lines 35-41 (tabs array):
```ts
  const tabs: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'feed', label: 'My Plans', icon: LayoutDashboard },
    { id: 'calendar', label: 'My Calendar', icon: CalendarDays },
    { id: 'family', label: 'My Family', icon: Users },
    { id: 'friends', label: 'My Friends', icon: Handshake },
    { id: 'groups', label: 'My Groups', icon: UsersRound },
  ]
```

New:
```ts
  const tabs: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'feed', label: 'My Plans', icon: LayoutDashboard },
    { id: 'family', label: 'My Family', icon: Users },
    { id: 'friends', label: 'My Friends', icon: Handshake },
    { id: 'groups', label: 'My Groups', icon: UsersRound },
  ]
```

- [ ] **Step 2: Remove calendar from Dashboard.tsx**

Old line 6:
```ts
import { MyCalendar } from '../components/MyCalendar'
```

Remove that line entirely.

Old line 17:
```ts
type View = 'feed' | 'calendar' | 'family' | 'friends' | 'groups' | 'settings'
```

New:
```ts
type View = 'feed' | 'family' | 'friends' | 'groups' | 'settings'
```

Old line 77:
```ts
        {currentView === 'calendar' && <MyCalendar />}
```

Remove that line entirely.

- [ ] **Step 3: Delete MyCalendar.tsx**

```bash
rm /Users/stroomnova/Music/plannen/src/components/MyCalendar.tsx
```

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```bash
cd /Users/stroomnova/Music/plannen && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: remove My Calendar nav tab, delete MyCalendar.tsx"
```

---

### Task 5: Verify in browser

- [ ] **Step 1: Start dev server**

```bash
cd /Users/stroomnova/Music/plannen && npm run dev
```

- [ ] **Step 2: Check these behaviours**

- My Plans page shows Compact | Detailed | Calendar toggle (three buttons)
- Calendar view renders a monthly grid with events on their dates
- Switching to calendar view and back preserves the choice in localStorage (refresh page, choice is remembered)
- Kind/status filter pills apply to calendar — selecting "Going" shows only Going events on the grid
- Sessions appear on their individual dates (not the parent event spanning the full range)
- Monthly/weekly sub-toggle inside the calendar grid works
- Clicking a day selects it and shows events in the right-hand panel
- Clicking a + button on a day opens the event form pre-filled with that date
- "My Calendar" tab is gone from the top nav
- No TypeScript errors in the browser console
