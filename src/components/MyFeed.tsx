import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Event, EventFormData, EventViewMode, EventStatus } from '../types/event'
import { getMyFeedEvents } from '../services/viewService'
import { getPreferredVisitDates } from '../services/rsvpService'
import { buildFutureTimeline, TimelineItem } from '../utils/timeline'
import { Timeline } from './Timeline'
import { CalendarGrid } from './CalendarGrid'
import { EventForm } from './EventForm'
import { AgentChat } from './AgentChat'
import { ConfirmModal } from './Modal'
import { Plus, ChevronUp } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { deleteEvent } from '../services/eventService'

const STATUS_FILTER_PILLS: { status: EventStatus; label: string; className: string; activeClassName: string }[] = [
  { status: 'going',      label: 'Going',      className: 'bg-white text-green-700 border-green-300',             activeClassName: 'bg-green-600 text-white border-green-600' },
  { status: 'interested', label: 'Interested', className: 'bg-white text-orange-700 border-orange-300',           activeClassName: 'bg-orange-500 text-white border-orange-500' },
  { status: 'planned',    label: 'Planned',    className: 'bg-white text-amber-700 border-amber-300',             activeClassName: 'bg-amber-500 text-white border-amber-500' },
  { status: 'watching',   label: 'Watching',   className: 'bg-white text-sky-700 border-sky-300',                 activeClassName: 'bg-sky-500 text-white border-sky-500' },
  { status: 'missed',     label: 'Missed',     className: 'bg-white text-yellow-700 border-yellow-300',           activeClassName: 'bg-yellow-500 text-white border-yellow-500' },
  { status: 'cancelled',  label: 'Cancelled',  className: 'bg-white text-red-600 border-red-300',                 activeClassName: 'bg-red-500 text-white border-red-500' },
]

// 'session' excluded — sessions are child records of recurring events, not standalone filterable items
const KIND_FILTER_PILLS: { kind: 'event' | 'reminder'; label: string; className: string; activeClassName: string }[] = [
  { kind: 'event',    label: 'Events',    className: 'bg-white text-indigo-700 border-indigo-300', activeClassName: 'bg-indigo-600 text-white border-indigo-600' },
  { kind: 'reminder', label: 'Reminders', className: 'bg-white text-purple-700 border-purple-300', activeClassName: 'bg-purple-600 text-white border-purple-600' },
]

export function MyFeed() {
  useAuth()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [preferredVisitDates, setPreferredVisitDates] = useState<Record<string, string | null>>({})
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [activeStatusFilter, setActiveStatusFilter] = useState<Set<EventStatus>>(new Set())
  const [activeKindFilter, setActiveKindFilter] = useState<Set<'event' | 'reminder'>>(new Set())
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)
  const [viewMode, setViewMode] = useState<EventViewMode>(() => {
    if (typeof window === 'undefined') return 'compact'
    const saved = window.localStorage.getItem('timelineViewMode')
    return saved === 'detailed' ? 'detailed' : saved === 'calendar' ? 'calendar' : 'compact'
  })
  const agentChatRef = useRef<{ resetDiscovery: () => void } | null>(null)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    setFeedError(null)
    const { data, error } = await getMyFeedEvents()
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
  }, [])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  useEffect(() => {
    const create = searchParams.get('create')
    if (create === '1') {
      setEditingEvent(undefined)
      setShowForm(true)
      navigate('/dashboard', { replace: true })
    }
  }, [searchParams, navigate])

  useEffect(() => {
    window.localStorage.setItem('timelineViewMode', viewMode)
  }, [viewMode])

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
    const { error } = await deleteEvent(deleteTargetId)
    if (error) {
      setFeedError(error.message)
      return
    }
    setDeleteTargetId(null)
    loadEvents()
  }

  const filteredEvents = events
    .filter((e) => activeKindFilter.size === 0 || activeKindFilter.has(e.event_kind === 'session' ? 'event' : e.event_kind))
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => (activeKindFilter.has('reminder') && !activeKindFilter.has('event')) || activeStatusFilter.size === 0 || activeStatusFilter.has(e.event_status))
  const futureTimeline = buildFutureTimeline(filteredEvents, preferredVisitDates)
  const past = filteredEvents
    .filter((e) => e.event_status === 'past')
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  const visiblePast = activeHashtag ? past : past.slice(-pastVisibleCount)
  const visiblePastTimelineItems: TimelineItem[] = visiblePast.map((event) => ({
    event,
    timelineDate: new Date(event.start_date),
    isImmediateNext: false,
    isPastToday: true,
  }))
  const combinedTimelineItems: TimelineItem[] = showPast
    ? [...visiblePastTimelineItems, ...futureTimeline]
    : futureTimeline
  const canLoadMorePast = !activeHashtag && pastVisibleCount < past.length
  const showEarlierButton = past.length > 0 && (!showPast || canLoadMorePast)
  const filtersActive = activeKindFilter.size > 0 || activeStatusFilter.size > 0 || !!activeHashtag
  const clearFilters = () => { setActiveHashtag(null); setActiveStatusFilter(new Set<EventStatus>()); setActiveKindFilter(new Set<'event' | 'reminder'>()) }
  const timelineEmptyMessage = filtersActive ? 'No upcoming events match your filters.' : 'No upcoming events. Create one or watch for a past event’s next occurrence.'

  const handleKindChange = (kind: 'event' | 'reminder') => {
    setActiveKindFilter(prev => {
      const next = new Set(prev)
      next.has(kind) ? next.delete(kind) : next.add(kind)
      if (next.has('reminder') && !next.has('event')) setActiveStatusFilter(new Set<EventStatus>())
      return next
    })
  }

  const handleStatusChange = (status: EventStatus) => {
    setActiveStatusFilter(prev => {
      const next = new Set(prev)
      next.has(status) ? next.delete(status) : next.add(status)
      return next
    })
  }

  return (
    <div className="space-y-8 w-full min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Plans</h2>
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
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex items-center min-h-[44px] py-2.5 px-4 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 text-sm sm:text-base order-last sm:order-none w-full sm:w-auto justify-center"
        >
          <Plus className="h-5 w-5 mr-2" />
          Create Event
        </button>
      </div>

      <AgentChat
        ref={agentChatRef}
        onEventCreated={loadEvents}
        onStartCreateWithData={(data) => {
          setEditingEvent(undefined)
          setInitialFormData(data)
          setShowForm(true)
        }}
      />

      <div className="flex justify-center gap-2 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
        {KIND_FILTER_PILLS.map(({ kind, label, className, activeClassName }) => (
          <button
            key={kind}
            type="button"
            onClick={() => handleKindChange(kind)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeKindFilter.has(kind) ? activeClassName : className
            }`}
          >
            {label}
          </button>
        ))}
        {STATUS_FILTER_PILLS.map(({ status, label, className, activeClassName }) => (
          <button
            key={status}
            type="button"
            onClick={() => handleStatusChange(status)}
            disabled={activeKindFilter.has('reminder') && !activeKindFilter.has('event')}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              activeKindFilter.has('reminder') && !activeKindFilter.has('event')
                ? 'opacity-40 cursor-not-allowed pointer-events-none'
                : activeStatusFilter.has(status)
                  ? activeClassName
                  : className
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {filtersActive && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-gray-500 hover:text-gray-700 underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {feedError && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{feedError}</p>
        </div>
      )}

      {loading ? (
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
              <section>
                {showEarlierButton && (
                  <div className="w-full max-w-2xl mx-auto min-w-0 mb-2 flex justify-start">
                    <button
                      type="button"
                      onClick={() => {
                        if (!showPast) setShowPast(true)
                        else setPastVisibleCount((count) => count + 5)
                      }}
                      className="inline-flex items-center text-xs text-gray-500 hover:text-gray-700"
                    >
                      <ChevronUp className="h-3 w-3 mr-1" />
                      Earlier
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
            agentChatRef.current?.resetDiscovery()
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
    </div>
  )
}
