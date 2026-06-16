import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Event, EventFormData, EventViewMode } from '../types/event'
import { supabase } from '../lib/supabase'
import { getGroupsEvents } from '../services/viewService'
import { TIER } from '../lib/tier'
import { getPreferredVisitDates } from '../services/rsvpService'
import { buildFutureTimeline, TimelineItem } from '../utils/timeline'
import { Timeline } from './Timeline'
import { CalendarGrid } from './CalendarGrid'
import { ScheduleOverview } from './ScheduleOverview'
import { EventForm } from './EventForm'
import { ManageGroups } from './ManageGroups'
import { Modal, ConfirmModal } from './Modal'
import { deleteEvent } from '../services/eventService'
import { ChevronUp, Settings, Star } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useChecklists } from '../hooks/useChecklists'
import { getMyGroups } from '../services/groupService'

// The persisted Compact / Calendar preference. 'schedule' is intentionally not a
// stored value (see the persistence effect), so reads collapse to compact.
function savedTimelineMode(): 'compact' | 'calendar' {
  if (typeof window === 'undefined') return 'compact'
  return window.localStorage.getItem('timelineViewMode') === 'calendar' ? 'calendar' : 'compact'
}

export function MyGroups() {
  const { profile } = useAuth()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const selectedGroupId = searchParams.get('group_id')
  // The Schedule dashboard (and three-way switcher) is reserved for the starred /
  // primary group — "All" and other groups keep Compact / Calendar only.
  const primaryGroupId = profile?.primary_group_id ?? null
  const isPrimarySelected = !!primaryGroupId && selectedGroupId === primaryGroupId
  const [events, setEvents] = useState<Event[]>([])
  const { checklists: groupChecklists, create: createGroupChecklist } = useChecklists()
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preferredVisitDates, setPreferredVisitDates] = useState<Record<string, string | null>>({})
  const [pastVisibleCount, setPastVisibleCount] = useState(5)
  const [showPast, setShowPast] = useState(false)
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | undefined>()
  const [initialFormData, setInitialFormData] = useState<Partial<EventFormData> | null>(null)
  const [groupNamesById, setGroupNamesById] = useState<Record<string, string>>({})
  const [eventGroupIdsByEventId, setEventGroupIdsByEventId] = useState<Record<string, string[]>>({})
  const [accessibleGroups, setAccessibleGroups] = useState<{ id: string; name: string }[]>([])
  const [showManageModal, setShowManageModal] = useState(false)
  const [viewMode, setViewMode] = useState<EventViewMode>(() => savedTimelineMode())
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

  // Never persist 'schedule' — the localStorage key is shared with Timeline /
  // other views, which only understand compact / calendar.
  useEffect(() => {
    if (viewMode === 'schedule') return
    window.localStorage.setItem('timelineViewMode', viewMode)
  }, [viewMode])

  // Default to Schedule each time the starred group is opened; leaving it falls
  // back to the saved compact / calendar mode. This gives "Schedule by default"
  // while still allowing in-visit switching.
  useEffect(() => {
    if (isPrimarySelected) {
      setViewMode('schedule')
    } else {
      setViewMode((cur) => (cur === 'schedule' ? savedTimelineMode() : cur))
    }
  }, [isPrimarySelected])

  useEffect(() => {
    if (TIER === '0') {
      setAccessibleGroups([])
      return
    }
    if (showManageModal) return
    let cancelled = false
    void (async () => {
      const { data } = await getMyGroups()
      if (cancelled) return
      const sorted = [...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
      setAccessibleGroups(sorted.map((g) => ({ id: g.id, name: g.name })))
    })()
    return () => { cancelled = true }
  }, [showManageModal])

  const matchesSelectedGroup = (event: Event) => {
    if (!selectedGroupId) return true
    return (eventGroupIdsByEventId[event.id] ?? []).includes(selectedGroupId)
  }
  const selectedGroupName = selectedGroupId ? (groupNamesById[selectedGroupId] ?? null) : null
  const pillGroups = (() => {
    if (accessibleGroups.length === 0) return []
    const primary = primaryGroupId ? accessibleGroups.find((g) => g.id === primaryGroupId) : null
    const rest = accessibleGroups.filter((g) => g.id !== primary?.id)
    return primary ? [primary, ...rest] : rest
  })()
  const filteredEvents = events
    .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
    .filter((e) => matchesSelectedGroup(e))
  const futureTimeline = buildFutureTimeline(filteredEvents, preferredVisitDates)
  // Past sorts asc and slice(-N) so the most-recent past event sits at the
  // bottom, immediately above "now" — matches MyFeed/MyPeople
  // (feedback_past_events_sort).
  const past = filteredEvents
    .filter((e) => e.event_status === 'past')
    .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
  const filterShowsAllPast = !!activeHashtag || !!selectedGroupId
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
  const handleDeleteClick = (eventId: string) => setDeleteTargetId(eventId)
  const handleDeleteConfirm = async () => {
    if (!deleteTargetId) return
    const { error: delErr } = await deleteEvent(deleteTargetId)
    if (delErr) {
      setError(delErr.message)
      return
    }
    setDeleteTargetId(null)
    await refresh()
  }

  return (
    <div className="space-y-8 w-full min-w-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Groups</h2>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5">
            {isPrimarySelected && (
              <button
                type="button"
                onClick={() => setViewMode('schedule')}
                className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'schedule' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                Schedule
              </button>
            )}
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
          <button
            type="button"
            onClick={() => setShowManageModal(true)}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            aria-label="Manage groups"
            title="Manage groups"
          >
            <Settings className="h-5 w-5" />
          </button>
        </div>
      </div>
      {pillGroups.length > 0 && (
        <div className="w-full max-w-2xl mx-auto">
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0">
            <button
              type="button"
              onClick={() => navigate('/dashboard?view=groups')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium whitespace-nowrap flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 ${
                !selectedGroupId ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              aria-pressed={!selectedGroupId}
            >
              All
            </button>
            {pillGroups.map((g) => {
              const isActive = selectedGroupId === g.id
              const isPrimary = primaryGroupId === g.id
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    if (isActive) {
                      navigate('/dashboard?view=groups')
                    } else {
                      navigate(`/dashboard?view=groups&group_id=${g.id}`)
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium whitespace-nowrap flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 ${
                    isActive ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                  aria-pressed={isActive}
                  aria-label={isPrimary ? `${g.name} (primary group)` : g.name}
                >
                  {isPrimary && <Star className="h-3.5 w-3.5 fill-current" aria-hidden />}
                  <span className="max-w-[160px] truncate">{g.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {error && (
        <div className="rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {loading && events.length === 0 ? (
        <p className="text-gray-500">Loading...</p>
      ) : events.length === 0 ? (
        <p className="text-gray-500">
          No events shared with any of your groups yet. Open Manage groups to create or edit groups, then share an event with a group from your My Plans feed — it&apos;ll appear here for you and everyone in that group.
        </p>
      ) : filteredEvents.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500 mb-4">
            No group events found
            {selectedGroupName ? ` for ${selectedGroupName}` : ''}
            {activeHashtag ? ` for #${activeHashtag}` : ''}.
          </p>
          {(activeHashtag || selectedGroupId) && (
            <button
              type="button"
              onClick={() => {
                setActiveHashtag(null)
                if (selectedGroupId) navigate('/dashboard?view=groups')
              }}
              className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Clear filters
            </button>
          )}
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
              heading={selectedGroupName ?? 'Schedule'}
              hideRoutines
              pinTrips
              tripChecklistsOf={(id) => groupChecklists.filter((c) => c.event_id === id)}
              onCreateChecklist={createGroupChecklist}
              onEdit={handleEdit}
              onDelete={handleDeleteClick}
              onShareSuccess={refresh}
              onHashtagClick={(tag) => {
                setActiveHashtag(tag)
                setShowPast(true)
              }}
            />
          ) : viewMode === 'calendar' ? (
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
            <section ref={pastSectionRef}>
              <div className="w-full max-w-2xl mx-auto min-w-0 mb-2 flex justify-start">
                {past.length > 0 && (!showPast || canLoadMorePast) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!showPast) {
                        setShowPast(true)
                        setTimeout(() => {
                          pastSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }, 0)
                      } else {
                        setPastVisibleCount((count) => count + 5)
                      }
                    }}
                    className="inline-flex items-center text-xs text-gray-500 hover:text-gray-700"
                  >
                    <ChevronUp className="h-3 w-3 mr-1" />
                    Earlier
                  </button>
                )}
              </div>
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
                emptyMessage="No upcoming group events. Share events with a group to see them here."
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

      <Modal isOpen={showManageModal} onClose={() => setShowManageModal(false)} title="Manage groups">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Create groups from your network and add or remove members. When you share an event with a group, everyone in that group sees it in My Groups.
          </p>
          <ManageGroups onSuccess={refresh} />
        </div>
      </Modal>

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
