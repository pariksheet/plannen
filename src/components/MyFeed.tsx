import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Event, EventFormData, EventViewMode } from '../types/event'
import { getMyFeedEvents } from '../services/viewService'
import { getWishlistEvents } from '../services/wishlistService'
import { getPreferredVisitDates } from '../services/rsvpService'
import { buildFutureTimeline, TimelineItem } from '../utils/timeline'
import { Timeline } from './Timeline'
import { EventList } from './EventList'
import { CalendarGrid } from './CalendarGrid'
import { EventForm } from './EventForm'
import { DiscoverButton } from './DiscoverButton'
import { ScheduleOverview } from './ScheduleOverview'
import { projectScheduleForDay } from '../services/schedulingService'
import { dbClient } from '../lib/dbClient'
import type { AttendanceInstanceRow, ResolvedObligationRow } from '../lib/dbClient/types'
import { ConfirmModal, PromptModal } from './Modal'
import { Plus, ChevronUp, ChevronDown, Calendar, X, Eye } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { deleteEvent, completeTodo, uncompleteTodo, convertEventKind } from '../services/eventService'
import { TripsSection } from './TripsSection'
import { supabase } from '../lib/supabase'

// Identifies events auto-created by the mailbox-sync routine.
function isRoutineCreated(event: { hashtags?: string[] | null; description?: string | null }): boolean {
  return (
    (event.hashtags?.includes('mbsync') ?? false) ||
    (event.description?.startsWith('Gmail-ID: ') ?? false)
  )
}

// Extracts a best-guess sender hint from a routine-created event description.
// Returns empty string if no hint is available.
function extractSenderHint(description: string | null): string {
  if (!description?.startsWith('Gmail-ID: ')) return ''
  // Description format: "Gmail-ID: <threadId>\n..." — we can't resolve the
  // sender client-side without a server call, so return empty (user will type).
  return ''
}

// 'session' excluded — sessions are child records of recurring events, not standalone filterable items
const KIND_FILTER_PILLS: { kind: 'event' | 'reminder' | 'todo'; label: string; className: string; activeClassName: string }[] = [
  { kind: 'event',    label: 'Events',    className: 'bg-white text-indigo-700 border-indigo-300', activeClassName: 'bg-indigo-600 text-white border-indigo-600' },
  { kind: 'reminder', label: 'Reminders', className: 'bg-white text-purple-700 border-purple-300', activeClassName: 'bg-purple-600 text-white border-purple-600' },
  { kind: 'todo',     label: 'To-dos',    className: 'bg-white text-amber-700 border-amber-300',   activeClassName: 'bg-amber-600 text-white border-amber-600' },
]

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function formatHumanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

export function MyFeed() {
  const { user } = useAuth()
  const { showToast } = useToast()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [muteSenderPrompt, setMuteSenderPrompt] = useState<{ eventId: string; senderHint: string } | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [preferredVisitDates, setPreferredVisitDates] = useState<Record<string, string | null>>({})
  const [watchQueue, setWatchQueue] = useState<Event[]>([])
  const [showWatchQueue, setShowWatchQueue] = useState(false)
  const [attendancesToday, setAttendancesToday] = useState<AttendanceInstanceRow[]>([])
  const [obligationsToday, setObligationsToday] = useState<ResolvedObligationRow[]>([])
  const [subjectNames, setSubjectNames] = useState<Record<string, string>>({})
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  // All kinds selected by default — show all. Toggling a pill hides that kind.
  const [activeKindFilter, setActiveKindFilter] = useState<Set<'event' | 'reminder' | 'todo'>>(
    () => new Set(['event', 'reminder', 'todo']),
  )
  const [selectedDate, setSelectedDate] = useState<string>('')
  const dateInputRef = useRef<HTMLInputElement>(null)
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)
  // Schedule is always the landing view — a previously-saved calendar/compact
  // preference no longer overrides it. The toggle still works within a session.
  const [viewMode, setViewMode] = useState<EventViewMode>('schedule')

  // Date-window fetch: default 30 days back, 60 days forward. "Earlier"
  // extends the back edge 90 days at a time once locally-revealed past is
  // exhausted. Forward edge is fixed — the feed isn't a long-horizon view.
  const toIso = (() => {
    const d = new Date()
    d.setDate(d.getDate() + 60)
    return d.toISOString().slice(0, 10)
  })()
  const initialFromIso = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })()
  const [fromIso, setFromIso] = useState<string>(initialFromIso)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Sticks once an unbounded retry succeeds — keeps subsequent reloads (after
  // create/edit/delete) from snapping back to the empty windowed view. A ref
  // (not state) so flipping it doesn't change loadEvents' identity and trigger
  // a redundant refetch through the effect.
  const windowExpandedRef = useRef(false)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setFeedError(null)
    const expanded = windowExpandedRef.current
    const params = expanded ? {} : { from_date: fromIso, to_date: toIso }
    const initial = await getMyFeedEvents(params)
    const { error } = initial
    let data = initial.data
    // Empty windowed result → retry unbounded once before showing the empty
    // state. Catches users whose only events lie past the fixed +60d forward
    // edge (e.g. summer camps booked months ahead).
    if (!error && data && data.length === 0 && !expanded) {
      const wide = await getMyFeedEvents()
      if (!wide.error && wide.data && wide.data.length > 0) {
        data = wide.data
        windowExpandedRef.current = true
      }
    }
    if (error) {
      setFeedError(error.message)
      setEvents([])
      setPreferredVisitDates({})
    } else if (data) {
      setEvents(data)
      const ids = data.map((e) => e.id)
      const { data: preferred } = await getPreferredVisitDates(ids)
      setPreferredVisitDates(preferred ?? {})
    }
    // The watch queue (watching + missed) regardless of the date window.
    const { data: wl } = await getWishlistEvents()
    setWatchQueue(wl ?? [])
    setLoading(false)
  }, [fromIso, toIso])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  // Today's read-only scheduling projection (attendances + derived obligations).
  // Fetched once on mount via the dbClient and projected client-side; the card
  // hides itself when both lists are empty, so failures degrade gracefully.
  useEffect(() => {
    let cancelled = false
    void projectScheduleForDay(ymd(new Date()))
      .then(({ attendancesToday: a, obligationsToday: o }) => {
        if (cancelled) return
        setAttendancesToday(a)
        setObligationsToday(o)
      })
      .catch((err) => {
        console.error('MyFeed: failed to project schedule', err)
      })
    return () => { cancelled = true }
  }, [])

  // Build subject-id → display-name map for event attribution chips.
  // Populated from family members (dbClient.relationships.listFamilyMembers).
  // TODO friends: RelationshipRow has no display-name column; extend once the
  // related_user profile is joinable from the web dbClient.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const members = await dbClient.relationships.listFamilyMembers()
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const m of members) map[m.id] = m.name
        setSubjectNames(map)
      } catch (err) {
        console.error('MyFeed: failed to load subject names', err)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const loadOlder = useCallback(() => {
    setLoadingOlder(true)
    const d = new Date(fromIso)
    d.setDate(d.getDate() - 90)
    setFromIso(d.toISOString().slice(0, 10))
    // Reveal newly-fetched past rows; the loadEvents effect fires off fromIso.
    setShowPast(true)
    setPastVisibleCount((c) => c + 10)
    setLoadingOlder(false)
  }, [fromIso])

  useEffect(() => {
    const create = searchParams.get('create')
    if (create === '1') {
      const prefillTitle = searchParams.get('prefill_title')
      const prefillUrl = searchParams.get('prefill_url')
      const prefillText = searchParams.get('prefill_text')
      const prefill: Partial<EventFormData> = {}
      if (prefillTitle) prefill.title = prefillTitle
      if (prefillUrl) prefill.enrollment_url = prefillUrl
      if (prefillText) prefill.description = prefillText
      if (Object.keys(prefill).length > 0) {
        setInitialFormData(prefill)
      } else {
        setInitialFormData(null)
      }
      setEditingEvent(undefined)
      setShowForm(true)
      navigate('/dashboard', { replace: true })
    }
  }, [searchParams, navigate])

  useEffect(() => {
    window.localStorage.setItem('timelineViewMode', viewMode)
  }, [viewMode])

  // Picking a date outside the current fetch window would otherwise silently
  // return nothing — flip to the unbounded fetch path and refetch. Also reveal
  // past so the filter can match past dates without manual paging.
  useEffect(() => {
    if (!selectedDate) return
    setShowPast(true)
    if (!windowExpandedRef.current && (selectedDate < fromIso || selectedDate > toIso)) {
      windowExpandedRef.current = true
      void loadEvents()
    }
  }, [selectedDate, fromIso, toIso, loadEvents])

  const handleCreate = () => {
    setEditingEvent(undefined)
    setShowForm(true)
  }

  const handleEdit = (event: Event) => {
    setEditingEvent(event)
    setShowForm(true)
  }

  const handleDeleteClick = (eventId: string) => {
    setDeleteTargetId(eventId)
    setFeedError(null)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTargetId) return
    const deletedEvent = events.find((e) => e.id === deleteTargetId) ?? null
    const { error } = await deleteEvent(deleteTargetId)
    if (error) {
      setFeedError(error.message)
      return
    }
    setDeleteTargetId(null)
    loadEvents()
    // After a successful delete, offer to mute the sender if this was a routine-created event.
    if (deletedEvent && isRoutineCreated(deletedEvent)) {
      setMuteSenderPrompt({
        eventId: deletedEvent.id,
        senderHint: extractSenderHint(deletedEvent.description),
      })
    }
  }

  const handleMuteSender = async (sender: string) => {
    const trimmed = sender.trim()
    if (!trimmed || !muteSenderPrompt) return
    if (!user) {
      setFeedError('Sign in required to mute senders.')
      return
    }
    const { error } = await supabase.from('mailbox_ignore_rules').upsert(
      { user_id: user.id, adapter_id: 'gmail', sender: trimmed, source_event_id: muteSenderPrompt.eventId },
      { onConflict: 'user_id,adapter_id,sender' },
    )
    if (error) {
      setFeedError(`Could not mute sender: ${error.message}`)
    }
    setMuteSenderPrompt(null)
  }

  const filteredEvents = events
    // Containers are shown in the Trips section, not as standalone timeline cards.
    .filter((e) => e.event_kind !== 'container')
    .filter((e) => activeKindFilter.has(e.event_kind === 'session' || e.event_kind === 'container' ? 'event' : e.event_kind))
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => {
      if (!selectedDate) return true
      const start = new Date(e.start_date)
      const end = e.end_date ? new Date(e.end_date) : start
      // Compare local-day keys so a multi-day event matches any day in its range.
      return ymd(start) <= selectedDate && selectedDate <= ymd(end)
    })
  const trips = events
    .filter((e) => e.event_kind === 'container')
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  const tripMembers = (tripId: string) =>
    events
      .filter((e) => e.group_id === tripId)
      .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  const futureTimeline = buildFutureTimeline(filteredEvents, preferredVisitDates)
  const past = filteredEvents
    .filter((e) => e.event_status === 'past')
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  const filterShowsAllPast = !!activeHashtag || !!selectedDate
  const visiblePast = filterShowsAllPast ? past : past.slice(-pastVisibleCount)
  const visiblePastTimelineItems: TimelineItem[] = visiblePast.map((event) => ({
    event,
    timelineDate: new Date(event.start_date),
    isImmediateNext: false,
    isPastToday: true,
  }))
  const combinedTimelineItems: TimelineItem[] = showPast
    ? [...visiblePastTimelineItems, ...futureTimeline]
    : futureTimeline
  const canLoadMorePast = !filterShowsAllPast && pastVisibleCount < past.length
  // Always offer the button (unless an explicit filter shows the full past) —
  // behavior cascades: reveal local past → page → extend the fetch window.
  const showEarlierButton = !filterShowsAllPast
  const kindFilterModified =
    !activeKindFilter.has('event') || !activeKindFilter.has('reminder') || !activeKindFilter.has('todo')
  const filtersActive = kindFilterModified || !!activeHashtag || !!selectedDate
  const clearFilters = () => {
    setActiveHashtag(null)
    setActiveKindFilter(new Set(['event', 'reminder', 'todo']))
    setSelectedDate('')
  }
  const timelineEmptyMessage = filtersActive ? 'No upcoming events match your filters.' : 'No upcoming events. Create one or watch for a past event’s next occurrence.'

  const handleKindChange = (kind: 'event' | 'reminder' | 'todo') => {
    setActiveKindFilter(prev => {
      const next = new Set(prev)
      next.has(kind) ? next.delete(kind) : next.add(kind)
      return next
    })
  }

  const handleToggleTodo = useCallback(async (event: Event) => {
    if (event.completed_at) await uncompleteTodo(event.id)
    else await completeTodo(event.id)
    loadEvents()
  }, [loadEvents])

  const handleConvertKind = useCallback(async (event: Event, kind: 'reminder' | 'todo') => {
    await convertEventKind(event.id, kind)
    loadEvents()
  }, [loadEvents])

  const openDatePicker = () => {
    const input = dateInputRef.current
    if (!input) return
    if (typeof input.showPicker === 'function') {
      try { input.showPicker(); return } catch { /* fall through */ }
    }
    input.focus()
    input.click()
  }

  return (
    <div className="space-y-8 w-full min-w-0">
      <div className="space-y-2">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Plans</h2>
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('schedule')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'schedule' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Schedule
            </button>
            <button
              type="button"
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'calendar' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => setViewMode('compact')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'compact' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Timeline
            </button>
          </div>
          <div className="flex items-center gap-2">
            <DiscoverButton
              onEventCreated={loadEvents}
              onStartCreateWithData={(data) => {
                setEditingEvent(undefined)
                setInitialFormData(data)
                setShowForm(true)
              }}
            />
            <button
              type="button"
              onClick={handleCreate}
              aria-label="Create event"
              className="inline-flex items-center min-h-[44px] py-2.5 px-3 sm:px-4 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 text-sm sm:text-base justify-center"
            >
              <Plus className="h-5 w-5 sm:mr-2" />
              <span className="hidden sm:inline">Create Event</span>
            </button>
          </div>
        </div>
      </div>

      {watchQueue.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowWatchQueue((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
            aria-expanded={showWatchQueue}
          >
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Eye className="h-4 w-4 text-indigo-500" />
              Watching
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold">
                {watchQueue.length}
              </span>
            </span>
            {showWatchQueue ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
          </button>
          {showWatchQueue && (
            <div className="px-4 pb-4 border-t border-gray-100 pt-3">
              <p className="text-xs text-gray-500 mb-2">Events you're tracking for the next occurrence. Open one and edit it to turn it into a real event.</p>
              <EventList
                events={watchQueue}
                onEdit={handleEdit}
                onDelete={handleDeleteClick}
                onShareSuccess={loadEvents}
                onHashtagClick={(tag) => { setActiveHashtag(tag); setShowPast(true) }}
                showActions
                showWatchButton={false}
                viewMode="compact"
              />
            </div>
          )}
        </div>
      )}

      <TripsSection
        trips={trips}
        childrenOf={tripMembers}
        onEditTrip={handleEdit}
        onDeleteEvent={handleDeleteClick}
        onChange={loadEvents}
        onToggleTodo={handleToggleTodo}
        onConvertKind={handleConvertKind}
        onHashtagClick={(tag) => { setActiveHashtag(tag); setShowPast(true) }}
      />

      {viewMode !== 'schedule' && (<>
      <div className="flex justify-center items-center gap-2 flex-wrap pb-1 -mx-1 px-1">
        {KIND_FILTER_PILLS.map(({ kind, label, className, activeClassName }) => (
          <button
            key={kind}
            type="button"
            onClick={() => handleKindChange(kind)}
            aria-pressed={activeKindFilter.has(kind)}
            className={`flex-shrink-0 inline-flex items-center justify-center min-h-[40px] px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
              activeKindFilter.has(kind) ? activeClassName : className
            }`}
          >
            {label}
          </button>
        ))}
        <label
          className={`relative inline-flex items-center justify-center flex-shrink-0 min-h-[40px] min-w-[40px] px-3 py-2 rounded-full text-sm font-medium border transition-colors cursor-pointer ${
            selectedDate
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}
          aria-label={selectedDate ? `Date filter: ${formatHumanDate(selectedDate)}. Change date.` : 'Filter events by date'}
        >
          <Calendar className="h-4 w-4 pointer-events-none" aria-hidden="true" />
          <input
            ref={dateInputRef}
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            onClick={(e) => {
              // On browsers that don't open the picker from input click directly,
              // call showPicker(). The label's click already focuses the input.
              const el = e.currentTarget
              if (typeof el.showPicker === 'function') {
                try { el.showPicker() } catch { /* native fallback */ }
              }
            }}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
        {/* Hidden helper so keyboard users can re-open the picker via a button
            with explicit semantics, in addition to the label affordance above. */}
        <button type="button" onClick={openDatePicker} className="sr-only">
          Open date picker
        </button>
      </div>

      {selectedDate && (
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 pl-3 pr-1 py-1 text-sm text-indigo-800">
            <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-medium">{formatHumanDate(selectedDate)}</span>
            <button
              type="button"
              onClick={() => setSelectedDate('')}
              aria-label="Clear date filter"
              className="inline-flex items-center justify-center min-h-[32px] min-w-[32px] rounded-full hover:bg-indigo-100 text-indigo-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {filtersActive && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={clearFilters}
            className="min-h-[40px] px-3 text-sm text-gray-500 hover:text-gray-700 underline"
          >
            Clear filters
          </button>
        </div>
      )}
      </>)}

      {feedError && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{feedError}</p>
        </div>
      )}

      {loading && events.length === 0 ? (
        <p className="text-gray-500">Loading events...</p>
      ) : events.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 mb-4">No events yet. Create your first event to get started.</p>
          <button
            type="button"
            onClick={handleCreate}
            className="inline-flex items-center min-h-[44px] py-2.5 px-4 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create Event
          </button>
        </div>
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

          {viewMode === 'schedule' ? (
            <ScheduleOverview
              events={filteredEvents}
              preferredVisitDates={preferredVisitDates}
              attendancesToday={attendancesToday}
              obligationsToday={obligationsToday}
              subjectNames={subjectNames}
              onEdit={handleEdit}
              onDelete={handleDeleteClick}
              onShareSuccess={loadEvents}
              onHashtagClick={(tag) => {
                setActiveHashtag(tag)
                setShowPast(true)
              }}
            />
          ) : viewMode === 'calendar' ? (
            <CalendarGrid
              events={[...filteredEvents, ...trips]}
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
              <section>
                {showEarlierButton && (
                  <div className="w-full max-w-2xl mx-auto min-w-0 mb-2 flex justify-start">
                    <button
                      type="button"
                      onClick={() => {
                        if (!showPast) setShowPast(true)
                        else if (canLoadMorePast) setPastVisibleCount((count) => count + 5)
                        else loadOlder()
                      }}
                      disabled={loadingOlder}
                      className="inline-flex items-center text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                    >
                      <ChevronUp className="h-3 w-3 mr-1" />
                      {loadingOlder
                        ? 'Loading…'
                        : (!showPast || canLoadMorePast ? 'Earlier' : 'Load older')}
                    </button>
                  </div>
                )}
                <Timeline
                  items={combinedTimelineItems}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                  onShareSuccess={loadEvents}
                  onHashtagClick={(tag) => {
                    setActiveHashtag(tag)
                    setShowPast(true)
                  }}
                  onToggleTodo={handleToggleTodo}
                  onConvertKind={handleConvertKind}
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

      {!showForm && (
        <button
          type="button"
          onClick={handleCreate}
          aria-label="Create event"
          className="sm:hidden fixed bottom-5 right-5 z-40 inline-flex items-center justify-center h-14 w-14 rounded-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-700 active:scale-95 transition-transform"
        >
          <Plus className="h-7 w-7" />
        </button>
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
          onSuccess={(result) => {
            const wasEdit = !!editingEvent
            setShowForm(false)
            setEditingEvent(undefined)
            setInitialFormData(null)
            if (result?.event) {
              // Guarantee the saved event is within the fetch window so it's
              // actually visible after the reload (e.g. a far-future camp).
              const startYmd = ymd(new Date(result.event.start_date))
              if (!windowExpandedRef.current && (startYmd < fromIso || startYmd > toIso)) {
                windowExpandedRef.current = true
              }
              const kind = result.event.event_kind
              const label = kind === 'todo' ? 'To-do' : kind === 'reminder' ? 'Reminder' : 'Event'
              showToast(`${label} ${result.created ? 'created' : 'updated'}`)
            } else {
              showToast(wasEdit ? 'Saved' : 'Created')
            }
            loadEvents()
          }}
        />
      )}

      <ConfirmModal
        isOpen={!!deleteTargetId}
        onClose={() => setDeleteTargetId(null)}
        title="Delete event?"
        message="This event will be permanently deleted."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
      />

      <PromptModal
        isOpen={!!muteSenderPrompt}
        onClose={() => setMuteSenderPrompt(null)}
        title="Mute this sender?"
        message="Dismissed. Enter the sender email to mute future emails from them."
        placeholder="sender@example.com"
        defaultValue={muteSenderPrompt?.senderHint ?? ''}
        confirmText="Mute this sender"
        cancelText="Just this one"
        type="email"
        onConfirm={handleMuteSender}
        onCancel={() => setMuteSenderPrompt(null)}
      />
    </div>
  )
}
