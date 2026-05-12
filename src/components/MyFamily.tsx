import { useState, useEffect, useCallback } from 'react'
import { Event, EventFormData, EventViewMode } from '../types/event'
import { getFamilyEvents } from '../services/viewService'
import { getPreferredVisitDates } from '../services/rsvpService'
import { getMyFamily, getRelationshipRequests } from '../services/relationshipService'
import { buildFutureTimeline, TimelineItem } from '../utils/timeline'
import { Timeline } from './Timeline'
import { EventForm } from './EventForm'
import { AddFamilyMember } from './AddFamilyMember'
import { PendingRequests } from './PendingRequests'
import { Modal } from './Modal'
import { ChevronUp, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export function MyFamily() {
  useAuth()
  const [events, setEvents] = useState<Event[]>([])
  const [family, setFamily] = useState<{ id: string; email: string | null; full_name: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preferredVisitDates, setPreferredVisitDates] = useState<Record<string, string | null>>({})
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [memberSearch, setMemberSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)
  const [showManageModal, setShowManageModal] = useState(false)
  const [pendingFamilyCount, setPendingFamilyCount] = useState(0)
  const [viewMode, setViewMode] = useState<EventViewMode>(() => {
    if (typeof window === 'undefined') return 'compact'
    const saved = window.localStorage.getItem('timelineViewMode')
    return saved === 'detailed' ? 'detailed' : 'compact'
  })
  const loadEvents = useCallback(async () => {
    const { data, error: err } = await getFamilyEvents()
    if (err) {
      setError(err.message)
      setEvents([])
      setPreferredVisitDates({})
    } else if (data) {
      setEvents(data)
      setError(null)
      const ids = data.map((e) => e.id)
      const { data: preferred } = await getPreferredVisitDates(ids)
      setPreferredVisitDates(preferred ?? {})
    }
  }, [])

  const loadFamily = useCallback(() => {
    getMyFamily().then(({ data }) => setFamily(data ?? []))
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      getFamilyEvents().then(async ({ data, error: err }) => {
        if (err) {
          setError(err.message)
          setEvents([])
          setPreferredVisitDates({})
        } else if (data) {
          setEvents(data)
          setError(null)
          const ids = data.map((e) => e.id)
          const { data: preferred } = await getPreferredVisitDates(ids)
          setPreferredVisitDates(preferred ?? {})
        }
        setLoading(false)
      }),
      getMyFamily().then(({ data }) => setFamily(data ?? [])),
    ])
  }, [])

  const loadPendingCount = useCallback(() => {
    getRelationshipRequests().then(({ data }) => {
      const familyPending = (data ?? []).filter((r) => r.relationship_type === 'family' || r.relationship_type === 'both')
      setPendingFamilyCount(familyPending.length)
    })
  }, [])

  const refresh = useCallback(async () => {
    await loadEvents()
    loadFamily()
    loadPendingCount()
  }, [loadEvents, loadFamily, loadPendingCount])

  useEffect(() => {
    loadPendingCount()
  }, [loadPendingCount])

  useEffect(() => {
    if (showManageModal) {
      loadFamily()
      loadPendingCount()
    }
  }, [showManageModal, loadFamily, loadPendingCount])

  useEffect(() => {
    window.localStorage.setItem('timelineViewMode', viewMode)
  }, [viewMode])

  const normalizedMemberSearch = memberSearch.trim().toLowerCase()
  const matchesMember = (event: Event) => {
    if (!normalizedMemberSearch) return true
    const member = family.find((m) => m.id === event.created_by)
    const label = `${member?.full_name ?? ''} ${member?.email ?? ''}`.trim().toLowerCase()
    return label.includes(normalizedMemberSearch)
  }
  const filteredEvents = events
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => matchesMember(e))
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
      shared_with_family: false,
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
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Family</h2>
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
        </div>
        <button
          type="button"
          onClick={() => setShowManageModal(true)}
          className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-indigo-600 text-indigo-700 font-medium rounded-md hover:bg-indigo-50 text-sm sm:text-base w-full sm:w-auto justify-center"
        >
          <Users className="h-5 w-5 mr-2" />
          Manage family
          {pendingFamilyCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-indigo-600 text-white text-xs font-medium">
              {pendingFamilyCount}
            </span>
          )}
        </button>
      </div>
      <div className="w-full max-w-2xl mx-auto min-w-0 bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex gap-2 min-w-0 flex-wrap sm:flex-nowrap">
          <input
            type="text"
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            placeholder="Search family member (name or email)"
            className="flex-1 min-w-0 px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : events.length === 0 ? (
        <p className="text-gray-500">No family events yet. Add family members via Manage family; when they share events with family, you&apos;ll see them here.</p>
      ) : filteredEvents.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 mb-4">
            No family events found
            {activeHashtag ? ` for #${activeHashtag}` : ''}
            {normalizedMemberSearch ? ` matching "${memberSearch}"` : ''}.
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
              emptyMessage="No upcoming family events. When family members share events with family, they appear here."
            />
          </section>
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

      <Modal isOpen={showManageModal} onClose={() => setShowManageModal(false)} title="Manage family">
        <div className="space-y-6">
          <section>
            <h3 className="text-base font-semibold text-gray-900 mb-2">Add family member</h3>
            <p className="text-sm text-gray-600 mb-3">They need to have signed up on Plannen. We&apos;ll send a request; they can accept from their account.</p>
            <AddFamilyMember onSuccess={refresh} />
          </section>
          <section>
            <h3 className="text-base font-semibold text-gray-900 mb-2">Family members</h3>
            {family.length === 0 ? (
              <p className="text-sm text-gray-500">No family members yet. Add someone by email above.</p>
            ) : (
              <ul className="space-y-2">
                {family.map((f) => (
                  <li key={f.id} className="text-sm text-gray-700">
                    {f.full_name || f.email || f.id}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <PendingRequests filter="family" onAcceptOrDecline={refresh} />
          </section>
        </div>
      </Modal>
    </div>
  )
}
