import { useState, useEffect, useCallback, useRef } from 'react'
import { Event, EventFormData, EventViewMode } from '../types/event'
import { supabase } from '../lib/supabase'
import { getGroupsEvents } from '../services/viewService'

const TIER = (import.meta.env.VITE_PLANNEN_TIER ?? '1') as '0' | '1'
import { getPreferredVisitDates } from '../services/rsvpService'
import { buildFutureTimeline } from '../utils/timeline'
import { Timeline } from './Timeline'
import { EventList } from './EventList'
import { EventForm } from './EventForm'
import { ManageGroups } from './ManageGroups'
import { Modal } from './Modal'
import { ChevronUp, UsersRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { getMyGroups } from '../services/groupService'

export function MyGroups() {
  useAuth()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preferredVisitDates, setPreferredVisitDates] = useState<Record<string, string | null>>({})
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [groupSearch, setGroupSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)
  const [groupNamesById, setGroupNamesById] = useState<Record<string, string>>({})
  const [eventGroupIdsByEventId, setEventGroupIdsByEventId] = useState<Record<string, string[]>>({})
  const [showManageModal, setShowManageModal] = useState(false)
  const [viewMode, setViewMode] = useState<EventViewMode>(() => {
    if (typeof window === 'undefined') return 'compact'
    const saved = window.localStorage.getItem('timelineViewMode')
    return saved === 'detailed' ? 'detailed' : 'compact'
  })
  const pastSectionRef = useRef<HTMLDivElement | null>(null)

  const loadEvents = useCallback(async () => {
    const { data, error: err } = await getGroupsEvents()
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

  useEffect(() => {
    setLoading(true)
    getGroupsEvents().then(async ({ data, error: err }) => {
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
    })
  }, [])

  const refresh = useCallback(async () => {
    await loadEvents()
  }, [loadEvents])

  const loadEventGroupsContext = useCallback(async (eventIds: string[]) => {
    if (eventIds.length === 0) {
      setGroupNamesById({})
      setEventGroupIdsByEventId({})
      return
    }
    if (TIER === '0') {
      // Tier 0 single-user: group-membership + cross-user event-sharing tables
      // aren't exposed by the v0 backend. Leave the context empty.
      setGroupNamesById({})
      setEventGroupIdsByEventId({})
      return
    }
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const [{ data: myGroups }, { data: myMemberships }] = await Promise.all([
      getMyGroups(),
      supabase.from('friend_group_members').select('group_id').eq('user_id', user.id),
    ])
    const accessibleGroupIds = Array.from(
      new Set([
        ...(myGroups ?? []).map((g) => g.id),
        ...((myMemberships ?? []).map((m: { group_id: string }) => m.group_id)),
      ])
    )
    if (accessibleGroupIds.length === 0) {
      setGroupNamesById({})
      setEventGroupIdsByEventId({})
      return
    }
    const [{ data: groups }, { data: eventGroupRows }] = await Promise.all([
      supabase.from('friend_groups').select('id,name').in('id', accessibleGroupIds),
      supabase
        .from('event_shared_with_groups')
        .select('event_id, group_id')
        .in('event_id', eventIds)
        .in('group_id', accessibleGroupIds),
    ])
    const names: Record<string, string> = {}
    for (const g of groups ?? []) names[g.id] = g.name
    const mapping: Record<string, string[]> = {}
    for (const row of eventGroupRows ?? []) {
      const current = mapping[row.event_id] ?? []
      if (!current.includes(row.group_id)) current.push(row.group_id)
      mapping[row.event_id] = current
    }
    setGroupNamesById(names)
    setEventGroupIdsByEventId(mapping)
  }, [])

  useEffect(() => {
    if (showManageModal) {
      loadEvents()
    }
  }, [showManageModal, loadEvents])

  useEffect(() => {
    void loadEventGroupsContext(events.map((e) => e.id))
  }, [events, loadEventGroupsContext])

  useEffect(() => {
    window.localStorage.setItem('timelineViewMode', viewMode)
  }, [viewMode])

  const normalizedGroupSearch = groupSearch.trim().toLowerCase()
  const matchesGroupSearch = (event: Event) => {
    if (!normalizedGroupSearch) return true
    const groupIds = eventGroupIdsByEventId[event.id] ?? []
    return groupIds.some((groupId) => (groupNamesById[groupId] ?? '').toLowerCase().includes(normalizedGroupSearch))
  }
  const filteredEvents = events
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => matchesGroupSearch(e))
  const futureTimeline = buildFutureTimeline(filteredEvents, preferredVisitDates)
  const past = filteredEvents.filter((e) => e.event_status === 'past')
  const visiblePast = activeHashtag ? past : past.slice(0, pastVisibleCount)
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
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Groups</h2>
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
          <UsersRound className="h-5 w-5 mr-2" />
          Manage groups
        </button>
      </div>
      <div className="w-full max-w-2xl mx-auto min-w-0 bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex gap-2 min-w-0 flex-wrap sm:flex-nowrap">
          <input
            type="text"
            value={groupSearch}
            onChange={(e) => setGroupSearch(e.target.value)}
            placeholder="Search group name"
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
        <p className="text-gray-500">
          No group events yet. Create groups in Manage groups (from your friends), then share events with those groups — they&apos;ll appear here for you and the group.
        </p>
      ) : filteredEvents.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 mb-4">
            No group events found
            {activeHashtag ? ` for #${activeHashtag}` : ''}
            {normalizedGroupSearch ? ` matching "${groupSearch}"` : ''}.
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
          {showPast && past.length > 0 && (
            <section ref={pastSectionRef}>
              <EventList
                events={visiblePast}
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
              onClone={handleClone}
              onHashtagClick={(tag) => {
                setActiveHashtag(tag)
                setShowPast(true)
              }}
              showRSVP
              showMemories
              showWatchButton={false}
              viewMode={viewMode}
              emptyMessage="No upcoming group events. Share events with a group to see them here."
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

      <Modal isOpen={showManageModal} onClose={() => setShowManageModal(false)} title="Manage groups">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Create groups from your friends and add or remove members. When you share an event with a group, everyone in that group sees it in My Groups.
          </p>
          <ManageGroups onSuccess={refresh} />
        </div>
      </Modal>
    </div>
  )
}
