import { useState, useEffect, useCallback } from 'react'
import { Event, EventFormData, EventViewMode } from '../types/event'
import { getFamilyEvents, getFriendsEvents } from '../services/viewService'
import { useAppRefresh } from '../lib/appRefresh'
import { getPreferredVisitDates } from '../services/rsvpService'
import { getMyConnections, getRelationshipRequests, type FriendUser } from '../services/relationshipService'
import { buildFutureTimeline, TimelineItem } from '../utils/timeline'
import { Timeline } from './Timeline'
import { CalendarGrid } from './CalendarGrid'
import { EventForm } from './EventForm'
import { AddPerson } from './AddPerson'
import { PendingRequests } from './PendingRequests'
import { SentInvites } from './SentInvites'
import { Modal } from './Modal'
import { ChevronUp, UsersRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { displayUserLabel } from '../utils/displayName'

function uniqById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

// viewService doesn't yet split events by connection — temporarily we keep
// using the legacy getFamilyEvents/getFriendsEvents stubs (both return []
// today) so the UI compiles; when group-share visibility is fully wired,
// switch to a getConnectionsEvents() helper.

export function MyPeople() {
  useAuth()
  const [events, setEvents] = useState<Event[]>([])
  const [people, setPeople] = useState<FriendUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preferredVisitDates, setPreferredVisitDates] = useState<Record<string, string | null>>({})
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [personSearch, setPersonSearch] = useState('')
  const [invitesKey, setInvitesKey] = useState(0)
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)
  const [showManageModal, setShowManageModal] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [viewMode, setViewMode] = useState<EventViewMode>(() => {
    if (typeof window === 'undefined') return 'compact'
    const saved = window.localStorage.getItem('timelineViewMode')
    return saved === 'calendar' ? 'calendar' : 'compact'
  })

  const loadEvents = useCallback(async () => {
    const [familyRes, friendsRes] = await Promise.all([getFamilyEvents(), getFriendsEvents()])
    const err = familyRes.error ?? friendsRes.error
    if (err) {
      setError(err.message)
      setEvents([])
      setPreferredVisitDates({})
      return
    }
    const merged = uniqById([...(familyRes.data ?? []), ...(friendsRes.data ?? [])])
    setEvents(merged)
    setError(null)
    const ids = merged.map((e) => e.id)
    const { data: preferred } = await getPreferredVisitDates(ids)
    setPreferredVisitDates(preferred ?? {})
  }, [])

  const loadPeople = useCallback(() => {
    getMyConnections().then(({ data }) => setPeople(data ?? []))
  }, [])

  const loadPendingCount = useCallback(() => {
    getRelationshipRequests().then(({ data }) => {
      setPendingCount((data ?? []).length)
    })
  }, [])

  const refresh = useCallback(async () => {
    await loadEvents()
    loadPeople()
    loadPendingCount()
  }, [loadEvents, loadPeople, loadPendingCount])

  // Header refresh button + regain-focus refetch (PWA has no browser reload).
  useAppRefresh(() => { void refresh() })

  useEffect(() => {
    setLoading(true)
    Promise.all([loadEvents(), Promise.resolve(loadPeople())]).finally(() => setLoading(false))
    loadPendingCount()
  }, [loadEvents, loadPeople, loadPendingCount])

  useEffect(() => {
    if (showManageModal) {
      loadPeople()
      loadPendingCount()
    }
  }, [showManageModal, loadPeople, loadPendingCount])

  useEffect(() => {
    window.localStorage.setItem('timelineViewMode', viewMode)
  }, [viewMode])

  const normalizedPersonSearch = personSearch.trim().toLowerCase()
  const matchesPerson = (event: Event) => {
    if (!normalizedPersonSearch) return true
    const person = people.find((p) => p.id === event.created_by)
    const label = `${person?.full_name ?? ''} ${person?.email ?? ''}`.trim().toLowerCase()
    return label.includes(normalizedPersonSearch)
  }
  const filteredEvents = events
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => matchesPerson(e))
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
  const handleClone = (source: Event) => {
    setEditingEvent(undefined)
    setInitialFormData({
      title: source.title,
      description: source.description ?? '',
      start_date: source.start_date,
      end_date: source.end_date ?? '',
      enrollment_url: source.enrollment_url ?? '',
      enrollment_deadline: source.enrollment_deadline ?? '',
      enrollment_start_date: source.enrollment_start_date ?? '',
      image_url: source.image_url ?? '',
      location: source.location ?? '',
      hashtags: source.hashtags ?? [],
      event_kind: source.event_kind,
      event_type: 'personal',
      shared_with_friends: 'none',
      shared_with_user_ids: [],
      shared_with_group_ids: [],
    })
    setShowForm(true)
  }
  const handleEdit = (event: Event) => {
    setInitialFormData(null)
    setEditingEvent(event)
    setShowForm(true)
  }

  return (
    <div className="space-y-8 w-full min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My People</h2>
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
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'calendar' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Calendar
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowManageModal(true)}
          className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-indigo-600 text-indigo-700 font-medium rounded-md hover:bg-indigo-50 text-sm sm:text-base w-full sm:w-auto justify-center"
        >
          <UsersRound className="h-5 w-5 mr-2" />
          Manage people
          {pendingCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-indigo-600 text-white text-xs font-medium">
              {pendingCount}
            </span>
          )}
        </button>
      </div>
      <div className="w-full max-w-2xl mx-auto min-w-0 bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex gap-2 min-w-0 flex-wrap sm:flex-nowrap">
          <input
            type="text"
            value={personSearch}
            onChange={(e) => setPersonSearch(e.target.value)}
            placeholder="Search a person (name or email)"
            className="flex-1 min-w-0 px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {loading && events.length === 0 ? (
        <p className="text-gray-500">Loading...</p>
      ) : events.length === 0 ? (
        <p className="text-gray-500">No shared events yet. Add people via Manage people; events they share with you appear here.</p>
      ) : filteredEvents.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 mb-4">
            No events found
            {activeHashtag ? ` for #${activeHashtag}` : ''}
            {normalizedPersonSearch ? ` matching "${personSearch}"` : ''}.
          </p>
          <button
            type="button"
            onClick={() => setActiveHashtag(null)}
            className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
          >
            Clear hashtag filter
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
              onShareSuccess={refresh}
              onDataChange={refresh}
              onClone={handleClone}
              onHashtagClick={(tag) => {
                setActiveHashtag(tag)
                setShowPast(true)
              }}
            />
          ) : (
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
                onClone={handleClone}
                onHashtagClick={(tag) => {
                  setActiveHashtag(tag)
                  setShowPast(true)
                }}
                showRSVP
                showMemories
                showWatchButton={false}
                viewMode={viewMode}
                emptyMessage="No upcoming events from your people. When someone shares an event with you, it appears here."
              />
            </section>
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
            refresh()
          }}
        />
      )}

      <Modal isOpen={showManageModal} onClose={() => setShowManageModal(false)} title="Manage people">
        <div className="space-y-6">
          <section>
            <h3 className="text-base font-semibold text-gray-900 mb-2">Add a person</h3>
            <p className="text-sm text-gray-600 mb-3">Enter their email. If they’re on Plannen we’ll send a request; if not, we’ll invite them and add them automatically once they join. Offline people you care about (kids, partner) live on your Profile.</p>
            <AddPerson onSuccess={() => { void refresh(); setInvitesKey((k) => k + 1) }} />
          </section>
          <section>
            <h3 className="text-base font-semibold text-gray-900 mb-2">People</h3>
            {people.length === 0 ? (
              <p className="text-sm text-gray-500">No connections yet. Add someone by email above.</p>
            ) : (
              <ul className="space-y-2">
                {people.map((p) => (
                  <li key={p.id} className="text-sm text-gray-700">
                    {displayUserLabel(p)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <PendingRequests onAcceptOrDecline={refresh} />
          </section>
          <section>
            <SentInvites refreshKey={invitesKey} />
          </section>
        </div>
      </Modal>
    </div>
  )
}
