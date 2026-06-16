import { useMemo, useState, useCallback } from 'react'
import {
  addDays,
  addMonths,
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
} from 'date-fns'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { Event, EventFormData } from '../types/event'
import { useToast } from '../context/ToastContext'
import { completeTodo, uncompleteTodo, convertEventKind } from '../services/eventService'
import { EventList } from './EventList'
import { EventDetailsModal } from './EventDetailsModal'
import { EventForm } from './EventForm'

interface CalendarGridProps {
  events: Event[]
  preferredVisitDates: Record<string, string | null>
  onDelete?: (eventId: string) => void
  onShareSuccess?: () => void
  onDataChange?: () => void
  onClone?: (event: Event) => void
  onHashtagClick?: (tag: string) => void
  /** Fired when a day cell is clicked — lets a parent that supplies its own sidebar (showSidebar=false) react to the selected date. */
  onDateSelect?: (date: Date) => void
  /** Show kebab + share button on events you created. */
  showActions?: boolean
  /** Render the inner selected-day aside. Defaults to true. Set false when embedding inside another card that supplies its own sidebar. */
  showSidebar?: boolean
  /** Smaller cells, fewer per-cell event chips. For embedding alongside other content. */
  compact?: boolean
}

// Max dots rendered per kind in a compact cell before showing a "+" overflow.
const DOT_CAP = 11

// Max simultaneous trip bands drawn per day before extra trips are hidden.
const MAX_TRIP_LANES = 3

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** A datetime-local string for `day` at a sensible default hour (the next
 *  round hour from now), used to seed the create form from a calendar day. */
function dayAtDefaultHour(day: Date): string {
  const hour = (new Date().getHours() + 1) % 24
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(hour)}:00`
}

export function CalendarGrid({ events, preferredVisitDates, onDelete, onShareSuccess, onDataChange, onClone, onHashtagClick, onDateSelect, showActions, showSidebar = true, compact = false }: CalendarGridProps) {
  const { showToast } = useToast()
  const [currentMonth, setCurrentMonth] = useState<Date>(startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState<Date>(new Date())
  const selectDay = (day: Date) => {
    setSelectedDate(day)
    onDateSelect?.(day)
  }
  const [focusedEvent, setFocusedEvent] = useState<Event | null>(null)
  const [rsvpVersion, setRsvpVersion] = useState(0)
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [createInitial, setCreateInitial] = useState<Partial<EventFormData> | undefined>()

  const handleCreateOnDay = (day: Date) => {
    setEditingEvent(undefined)
    setCreateInitial({ start_date: dayAtDefaultHour(day) })
    setShowForm(true)
  }

  const currentYear = new Date().getFullYear()
  const yearOptions = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i)
  const monthOptions = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]

  const handleEdit = (event: Event) => {
    setEditingEvent(event)
    setShowForm(true)
  }

  const handleToggleTodo = useCallback(async (event: Event) => {
    if (event.completed_at) await uncompleteTodo(event.id)
    else await completeTodo(event.id)
    onDataChange?.()
  }, [onDataChange])

  const handleConvertKind = useCallback(async (event: Event, kind: 'reminder' | 'todo') => {
    await convertEventKind(event.id, kind)
    onDataChange?.()
  }, [onDataChange])

  const eventsByDay = useMemo(() => {
    // Skip parent recurring events that have child sessions in this events array
    const parentIds = new Set(
      events.filter(e => e.parent_event_id).map(e => e.parent_event_id!)
    )

    const byDay = new Map<string, Event[]>()
    for (const event of events) {
      if (parentIds.has(event.id)) continue
      // Cancelled events don't belong on the calendar
      if (event.event_status === 'cancelled') continue
      // Trips (containers) render as spanning bands, not per-day dots.
      if (event.event_kind === 'container') continue

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

  // Trips (containers) draw as continuous bands across the days they span.
  // Pack them into horizontal lanes (greedy) so non-overlapping trips reuse a
  // lane and the same trip keeps one lane across week rows.
  const tripBands = useMemo(() => {
    const trips = events
      .filter((e) => e.event_kind === 'container' && e.start_date && e.end_date)
      .map((e) => ({
        id: e.id,
        title: e.title,
        event: e,
        s: startOfDay(new Date(e.start_date)).getTime(),
        e2: startOfDay(new Date(e.end_date!)).getTime(),
        lane: 0,
      }))
      .filter((t) => t.e2 >= t.s)
      .sort((a, b) => a.s - b.s)
    const laneEnds: number[] = []
    for (const t of trips) {
      let lane = laneEnds.findIndex((end) => end < t.s)
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(t.e2) }
      else laneEnds[lane] = t.e2
      t.lane = lane
    }
    return { trips, laneCount: Math.min(laneEnds.length, MAX_TRIP_LANES) }
  }, [events])

  const renderTripBands = (day: Date) => {
    if (tripBands.laneCount === 0) return null
    const dayMs = startOfDay(day).getTime()
    const isWeekStart = day.getDay() === 1 // Monday — first column
    return (
      <div className="mt-0.5 space-y-0.5">
        {Array.from({ length: tripBands.laneCount }).map((_, lane) => {
          const t = tripBands.trips.find((x) => x.lane === lane && dayMs >= x.s && dayMs <= x.e2)
          if (!t) return <div key={lane} className="h-3" aria-hidden />
          const isStart = dayMs === t.s
          const isEnd = dayMs === t.e2
          return (
            <button
              key={lane}
              type="button"
              onClick={(ev) => { ev.stopPropagation(); setFocusedEvent(t.event) }}
              title={t.title}
              className={`block w-full h-3 bg-violet-500 text-white text-[9px] leading-3 px-1 truncate text-left hover:bg-violet-600 ${isStart ? 'rounded-l' : ''} ${isEnd ? 'rounded-r' : ''}`}
            >
              {isStart || isWeekStart ? t.title : ' '}
            </button>
          )
        })}
      </div>
    )
  }

  const monthEventCount = useMemo(() => {
    const seen = new Set<string>()
    for (const [key, dayEvents] of eventsByDay) {
      const [year, month] = key.split('-').map(Number)
      if (year === currentMonth.getFullYear() && month === currentMonth.getMonth() + 1) {
        for (const e of dayEvents) seen.add(e.id)
      }
    }
    return seen.size
  }, [eventsByDay, currentMonth])

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
  const days: Date[] = []
  for (let d = new Date(gridStart.getTime()); d <= gridEnd; d = addDays(d, 1)) {
    days.push(new Date(d.getTime()))
  }

  const selectedKey = toDateKey(selectedDate)
  // Containers are kept out of eventsByDay (they render as bands, not per-day
  // entries), but the clicked-day detail should still list any trip whose range
  // spans that day — otherwise clicking a date inside a trip shows nothing.
  const selectedMs = startOfDay(selectedDate).getTime()
  const selectedTrips = events.filter((e) => {
    if (e.event_kind !== 'container' || !e.start_date) return false
    const s = startOfDay(new Date(e.start_date)).getTime()
    const en = e.end_date ? startOfDay(new Date(e.end_date)).getTime() : s
    return s <= selectedMs && en >= selectedMs
  })
  const selectedEvents = [...selectedTrips, ...(eventsByDay.get(selectedKey) ?? [])]
    .slice()
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())

  return (
    <div className="space-y-4">
      <div className={`w-full max-w-6xl mx-auto grid grid-cols-1 ${showSidebar ? 'lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]' : ''} gap-4 items-start`}>
        <div className="bg-white rounded-lg border border-gray-200 p-4 w-full">
          <div className="flex items-center justify-between mb-4">
            <button
              type="button"
              onClick={() => setCurrentMonth((prev) => subMonths(prev, 1))}
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
              <span className="text-sm text-gray-500">({monthEventCount})</span>
            </div>
            <button
              type="button"
              onClick={() => setCurrentMonth((prev) => addMonths(prev, 1))}
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
              const todoCount = dayEvents.filter((e) => e.event_kind === 'todo').length
              const eventCount = dayEvents.filter((e) => e.event_kind !== 'reminder' && e.event_kind !== 'todo').length
              const reminderCount = dayEvents.filter((e) => e.event_kind === 'reminder').length
              const inMonth = isSameMonth(day, currentMonth)
              const isSelected = isSameDay(day, selectedDate)
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectDay(day)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectDay(day) }}
                  className={`text-left rounded-md border transition-colors ${compact ? 'p-1 min-h-[60px]' : 'p-1.5 min-h-[90px]'} ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-50'
                      : isToday(day)
                        ? 'border-emerald-300 bg-emerald-50'
                        : inMonth
                          ? 'border-gray-200 bg-white hover:bg-gray-50'
                          : 'border-gray-100 bg-gray-50 text-gray-400'
                  }`}
                >
                  <div className="w-full flex items-center justify-between">
                    <span className={`${compact ? 'text-[10px]' : 'text-xs'} font-medium ${isToday(day) ? 'text-indigo-700' : ''}`}>
                      {format(day, 'd')}
                    </span>
                    {!compact && dayEvents.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        {reminderCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-green-600" aria-label={`${reminderCount} reminders`} />}
                        {todoCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label={`${todoCount} todos`} />}
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold">
                          {dayEvents.length}
                        </span>
                      </span>
                    )}
                  </div>
                  {renderTripBands(day)}
                  {compact && dayEvents.length > 0 && (
                    // One dot per item (blue = event, green = reminder, amber = todo), wrapped
                    // and capped so a busy day can't blow out the cell. The
                    // aria-label always carries the true counts.
                    <div
                      className="mt-0.5 flex flex-wrap items-center gap-0.5"
                      aria-label={`${eventCount} events, ${reminderCount} reminders, ${todoCount} todos`}
                    >
                      {Array.from({ length: Math.min(eventCount, DOT_CAP) }).map((_, i) => (
                        <span key={`e${i}`} className="h-1.5 w-1.5 rounded-full bg-blue-600" />
                      ))}
                      {Array.from({ length: Math.min(reminderCount, DOT_CAP) }).map((_, i) => (
                        <span key={`r${i}`} className="h-1.5 w-1.5 rounded-full bg-green-600" />
                      ))}
                      {Array.from({ length: Math.min(todoCount, DOT_CAP) }).map((_, i) => (
                        <span key={`t${i}`} className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      ))}
                      {(eventCount > DOT_CAP || reminderCount > DOT_CAP || todoCount > DOT_CAP) && (
                        <span className="text-[9px] leading-none text-gray-500">+</span>
                      )}
                    </div>
                  )}
                  {!compact && (
                    <div className="mt-1 min-h-[1.25rem] space-y-0.5 overflow-visible">
                      {dayEvents.slice(0, 2).map((event) => (
                        <button
                          key={event.id}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setFocusedEvent(event) }}
                          className="block w-full min-w-0 text-left text-[10px] leading-tight text-gray-700 truncate hover:text-indigo-700 hover:underline"
                        >
                          {event.title}
                        </button>
                      ))}
                      {dayEvents.length > 2 && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); selectDay(day) }}
                          className="block w-full text-left text-[10px] leading-tight text-indigo-600 hover:underline"
                        >
                          +{dayEvents.length - 2} more
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {showSidebar && (
          <aside className="space-y-3 lg:sticky lg:top-24">
            <div className="bg-white rounded-lg border border-gray-200 p-3">
              <h4 className="text-sm font-semibold text-gray-700">
                {format(selectedDate, 'EEEE, MMM d, yyyy')}
              </h4>
            </div>
            {selectedEvents.length === 0 ? (
              <div className="text-center py-8 bg-white rounded-lg border border-gray-200">
                <p className="text-gray-500 text-sm">No events on this day.</p>
                <button
                  type="button"
                  onClick={() => handleCreateOnDay(selectedDate)}
                  className="mt-3 inline-flex items-center gap-1 px-3 py-2 min-h-[40px] rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100"
                >
                  <Plus className="h-4 w-4" />
                  Add event on this day
                </button>
              </div>
            ) : (
              <EventList
                events={selectedEvents}
                onEdit={handleEdit}
                onClone={onClone}
                onDelete={onDelete}
                onShareSuccess={onShareSuccess}
                onHashtagClick={onHashtagClick}
                onToggleTodo={handleToggleTodo}
                onConvertKind={handleConvertKind}
                showActions={showActions}
                showRSVP
                showMemories
                showWatchButton={false}
                viewMode="compact"
              />
            )}
          </aside>
        )}
      </div>

      {focusedEvent && (
        <EventDetailsModal
          event={focusedEvent}
          isOpen={!!focusedEvent}
          onClose={() => setFocusedEvent(null)}
          onEdit={handleEdit}
          showRSVP
          showMemories
          rsvpVersion={rsvpVersion}
          onRsvpVersionChange={() => setRsvpVersion((v) => v + 1)}
        />
      )}

      {showForm && (
        <EventForm
          event={editingEvent}
          initialData={editingEvent ? undefined : createInitial}
          onClose={() => {
            setShowForm(false)
            setEditingEvent(undefined)
            setCreateInitial(undefined)
          }}
          onSuccess={(result) => {
            const wasEdit = !!editingEvent
            setShowForm(false)
            setEditingEvent(undefined)
            setCreateInitial(undefined)
            const kind = result?.event.event_kind
            const label = kind === 'todo' ? 'To-do' : kind === 'reminder' ? 'Reminder' : 'Event'
            showToast(result ? `${label} ${result.created ? 'created' : 'updated'}` : (wasEdit ? 'Saved' : 'Created'))
            onDataChange?.()
          }}
        />
      )}
    </div>
  )
}
