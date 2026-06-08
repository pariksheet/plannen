import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Event, EventFormData, EventViewMode } from '../types/event'
import { getMyFeedEvents } from '../services/viewService'
import { getPreferredVisitDates } from '../services/rsvpService'
import { buildFutureTimeline, TimelineItem } from '../utils/timeline'
import { Timeline } from './Timeline'
import { CalendarGrid } from './CalendarGrid'
import { EventForm } from './EventForm'
import { DiscoverButton } from './DiscoverButton'
import { ScheduleOverview } from './ScheduleOverview'
import { ConfirmModal, PromptModal } from './Modal'
import { Plus, ChevronUp, Calendar, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { deleteEvent } from '../services/eventService'
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
const KIND_FILTER_PILLS: { kind: 'event' | 'reminder'; label: string; className: string; activeClassName: string }[] = [
  { kind: 'event',    label: 'Events',    className: 'bg-white text-indigo-700 border-indigo-300', activeClassName: 'bg-indigo-600 text-white border-indigo-600' },
  { kind: 'reminder', label: 'Reminders', className: 'bg-white text-purple-700 border-purple-300', activeClassName: 'bg-purple-600 text-white border-purple-600' },
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
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  // Both kinds selected by default — show all. Toggling a pill hides that kind.
  const [activeKindFilter, setActiveKindFilter] = useState<Set<'event' | 'reminder'>>(
    () => new Set(['event', 'reminder']),
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
    setLoading(false)
  }, [fromIso, toIso])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

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
    .filter((e) => activeKindFilter.has(e.event_kind === 'session' ? 'event' : e.event_kind))
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => {
      if (!selectedDate) return true
      const start = new Date(e.start_date)
      const end = e.end_date ? new Date(e.end_date) : start
      // Compare local-day keys so a multi-day event matches any day in its range.
      return ymd(start) <= selectedDate && selectedDate <= ymd(end)
    })
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
    !activeKindFilter.has('event') || !activeKindFilter.has('reminder')
  const filtersActive = kindFilterModified || !!activeHashtag || !!selectedDate
  const clearFilters = () => {
    setActiveHashtag(null)
    setActiveKindFilter(new Set(['event', 'reminder']))
    setSelectedDate('')
  }
  const timelineEmptyMessage = filtersActive ? 'No upcoming events match your filters.' : 'No upcoming events. Create one or watch for a past event’s next occurrence.'

  const handleKindChange = (kind: 'event' | 'reminder') => {
    setActiveKindFilter(prev => {
      const next = new Set(prev)
      next.has(kind) ? next.delete(kind) : next.add(kind)
      return next
    })
  }

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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Plans</h2>
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
        </div>
        <div className="flex items-center gap-2 order-last sm:order-none w-full sm:w-auto">
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
            className="inline-flex flex-1 sm:flex-none items-center min-h-[44px] py-2.5 px-4 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 text-sm sm:text-base justify-center"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create Event
          </button>
        </div>
      </div>

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
