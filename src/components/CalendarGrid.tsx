import { useMemo, useState } from 'react'
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
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Event } from '../types/event'
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
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()

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
  const selectedEvents = (eventsByDay.get(selectedKey) ?? [])
    .slice()
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())

  return (
    <div className="space-y-4">
      <div className="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] gap-4 items-start">
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
              const inMonth = isSameMonth(day, currentMonth)
              const isSelected = isSameDay(day, selectedDate)
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedDate(day)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedDate(day) }}
                  className={`text-left rounded-md border p-1.5 transition-colors min-h-[90px] ${
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
                    <span className={`text-xs font-medium ${isToday(day) ? 'text-indigo-700' : ''}`}>
                      {format(day, 'd')}
                    </span>
                    {dayEvents.length > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-semibold">
                        {dayEvents.length}
                      </span>
                    )}
                  </div>
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
            <h4 className="text-sm font-semibold text-gray-700">
              {format(selectedDate, 'EEEE, MMM d, yyyy')}
            </h4>
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
          onClose={() => {
            setShowForm(false)
            setEditingEvent(undefined)
          }}
          onSuccess={() => {
            setShowForm(false)
            setEditingEvent(undefined)
            onDataChange?.()
          }}
        />
      )}
    </div>
  )
}
