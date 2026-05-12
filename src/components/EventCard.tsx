import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Event, EventViewMode } from '../types/event'
import { format } from 'date-fns'
import { Calendar, Users, Pencil, Trash2, CalendarDays, Bell, CheckCircle, Eye, Share2, UserPlus, MapPin, Handshake, Lock, Copy, CalendarPlus, Download, MessageCircle, Layers, MoreVertical } from 'lucide-react'
import { getMyRsvp, getRsvpList, type RsvpStatus } from '../services/rsvpService'
import { getEvent } from '../services/eventService'
import { getEventWatchTask, WatchTask } from '../services/agentTaskService'
import { useAuth } from '../context/AuthContext'
import { RSVPButton } from './RSVPButton'
import { RSVPList } from './RSVPList'
import { EventMemoryComponent } from './EventMemory'
import { WatchForNextYearButton } from './WatchForNextYearButton'
import { PreferredVisitDate } from './PreferredVisitDate'
import { EventShareModal } from './EventShareModal'
import { EventInviteModal } from './EventInviteModal'
import { EventDetailsModal } from './EventDetailsModal'
import { downloadIcs, getGoogleCalendarAddUrl, getOutlookCalendarAddUrl } from '../services/calendarExport'
import { getWhatsAppShareUrl } from '../utils/whatsappShare'
import type { EventStatus } from '../types/event'

const STATUS_BADGE: Record<EventStatus, { label: string; className: string }> = {
  watching:   { label: 'Watching',   className: 'bg-sky-100 text-sky-800' },
  planned:    { label: 'Planned',    className: 'bg-amber-100 text-amber-800' },
  interested: { label: 'Interested', className: 'bg-orange-100 text-orange-800' },
  going:      { label: 'Going',       className: 'bg-green-100 text-green-800' },
  cancelled:  { label: 'Cancelled',  className: 'bg-red-100 text-red-700' },
  past:       { label: 'Attended',   className: 'bg-gray-100 text-gray-600' },
  missed:     { label: 'Missed',     className: 'bg-yellow-100 text-yellow-800' },
}

function StatusBadge({ status, size = 'sm' }: { status: EventStatus; size?: 'xs' | 'sm' }) {
  const cfg = STATUS_BADGE[status]
  if (!cfg || status === 'going') return null
  const textClass = size === 'xs' ? 'text-[11px]' : 'text-xs'
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium ${textClass} ${cfg.className}`}>
      {cfg.label}
    </span>
  )
}

function MyRsvpBadge({ eventId, showRSVP, refreshTrigger }: { eventId: string; showRSVP: boolean; refreshTrigger?: number }) {
  const [status, setStatus] = useState<RsvpStatus | null>(null)
  useEffect(() => {
    if (!showRSVP) return
    getMyRsvp(eventId).then(({ data }) => setStatus(data?.status ?? null))
  }, [eventId, showRSVP, refreshTrigger])
  if (!status || status === 'not_going') return null
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        status === 'going' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
      }`}
    >
      <CheckCircle className="h-3 w-3" />
      {status === 'going' ? 'Going' : 'Maybe'}
    </span>
  )
}

function CompactRsvpInitials({
  eventId,
  showRSVP,
  refreshTrigger,
}: {
  eventId: string
  showRSVP: boolean
  refreshTrigger?: number
}) {
  const [data, setData] = useState<{ going: { id: string; full_name?: string; email?: string }[]; maybe: { id: string; full_name?: string; email?: string }[]; not_going: { id: string; full_name?: string; email?: string }[] } | null>(null)

  useEffect(() => {
    if (!showRSVP) return
    getRsvpList(eventId).then(({ data: d }) => setData(d ?? null))
  }, [eventId, showRSVP, refreshTrigger])

  if (!showRSVP || !data) return null
  const { going, maybe, not_going } = data
  const total = going.length + maybe.length + not_going.length
  if (total === 0) return null

  return (
    <span className="mt-1.5 block text-[11px] text-slate-600" title={`${going.length} going, ${maybe.length} maybe, ${not_going.length} not going`}>
      <span className="font-medium text-green-700">{going.length}</span> going
      <span className="mx-1 text-slate-400">·</span>
      <span className="font-medium text-amber-600">{maybe.length}</span> maybe
      {not_going.length > 0 && (
        <>
          <span className="mx-1 text-slate-400">·</span>
          <span className="font-medium text-red-600">{not_going.length}</span> not going
        </>
      )}
    </span>
  )
}

interface EventCardProps {
  event: Event
  onEdit?: (event: Event) => void
  onClone?: (event: Event) => void
  onDelete?: (eventId: string) => void
  onShareSuccess?: () => void
  onHashtagClick?: (tag: string) => void
  showActions?: boolean
  showRSVP?: boolean
  showMemories?: boolean
  showWatchButton?: boolean
  /** First event in the timeline (next up). */
  isImmediateNext?: boolean
  /** For wishlist/missed: when we expect the next occurrence (ISO string). */
  nextExpectedDate?: string
  viewMode?: EventViewMode
  /** Visually de-emphasise the card (today's events that have already passed). */
  dimmed?: boolean
}

export function EventCard({
  event,
  onEdit,
  onClone,
  onDelete,
  onShareSuccess,
  onHashtagClick,
  showActions = false,
  showRSVP = true,
  showMemories = false,
  showWatchButton = false,
  isImmediateNext = false,
  nextExpectedDate,
  viewMode = 'compact',
  dimmed = false,
}: EventCardProps) {
  const { user } = useAuth()
  const isMissed = event.event_status === 'missed'
  const isWishlist = event.event_status === 'watching'
  const isWatching = isMissed || isWishlist
  const isReminder = event.event_kind === 'reminder'
  const isOrganizer = user?.id === event.created_by
  const [myRsvpStatus, setMyRsvpStatus] = useState<RsvpStatus | null>(event.my_rsvp_status ?? null)
  const isOwnNotGoing = isOrganizer && myRsvpStatus === 'not_going'
  const [imageError, setImageError] = useState(false)
  const imageUrl = event.image_url ?? null
  const showImage = Boolean(imageUrl && !imageError)
  const placeholderGradients: Record<string, string> = {
    personal: 'from-violet-500 to-purple-700',
    friends: 'from-amber-400 to-orange-500',
    family: 'from-emerald-500 to-teal-600',
    group: 'from-indigo-500 to-blue-600',
  }
  const gradient = placeholderGradients[event.event_type] || 'from-slate-500 to-slate-700'
  const sharedFamily = event.shared_with_family ?? false
  const sharedFriends = (event.shared_with_friends ?? 'none') !== 'none'
  const [showViewModal, setShowViewModal] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [rsvpVersion, setRsvpVersion] = useState(0)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [showMobileSwipeRsvp, setShowMobileSwipeRsvp] = useState(false)
  const [showKebabMenu, setShowKebabMenu] = useState(false)
  const [kebabMenuPosition, setKebabMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [kebabVisitDate, setKebabVisitDate] = useState<string | null>(null)
  const kebabMenuRef = useRef<HTMLDivElement>(null)
  const kebabTriggerRef = useRef<HTMLButtonElement>(null)
  const kebabPortalRef = useRef<HTMLDivElement>(null)
  const touchStartXRef = useRef<number | null>(null)
  const touchStartYRef = useRef<number | null>(null)
  const didSwipeRef = useRef(false)
  const [parentEvent, setParentEvent] = useState<import('../types/event').Event | null>(null)
  const [parentRsvpVersion, setParentRsvpVersion] = useState(0)
  const [resolvedParentTitle, setResolvedParentTitle] = useState<string | null>(event.parent_title ?? null)
  const [watchTask, setWatchTask] = useState<WatchTask | null>(null)

  useEffect(() => {
    setResolvedParentTitle(event.parent_title ?? null)
    if (event.parent_title || !event.parent_event_id) return
    let cancelled = false
    getEvent(event.parent_event_id).then(({ data }) => {
      if (!cancelled && data) setResolvedParentTitle(data.title)
    })
    return () => { cancelled = true }
  }, [event.id, event.parent_event_id, event.parent_title])

  useEffect(() => {
    if (!event.enrollment_url) return
    let isMounted = true
    getEventWatchTask(event.id)
      .then((task) => {
        if (isMounted) setWatchTask(task)
      })
      .catch((err) => {
        if (isMounted) console.error('Failed to fetch watch task:', err)
      })
    return () => { isMounted = false }
  }, [event.id, event.enrollment_url])

  const updateBadge = watchTask?.has_unread_update && watchTask.update_summary ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-200">
      {watchTask.update_summary}
    </span>
  ) : null

  async function handleViewParent(e: React.MouseEvent) {
    e.stopPropagation()
    if (!event.parent_event_id) return
    const { data } = await getEvent(event.parent_event_id)
    if (data) setParentEvent(data)
  }
  const canSwipeRsvp = showRSVP && !isWatching && !isReminder

  useEffect(() => {
    if (!showRSVP || isWatching || isReminder) return
    getMyRsvp(event.id).then(({ data }) => {
      setMyRsvpStatus(data?.status ?? null)
    })
  }, [event.id, showRSVP, isWatching, isReminder, rsvpVersion])

  useLayoutEffect(() => {
    if (showKebabMenu && kebabTriggerRef.current) {
      const rect = kebabTriggerRef.current.getBoundingClientRect()
      const padding = 4
      const menuWidth = 192
      setKebabMenuPosition({
        top: rect.bottom + padding,
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      })
      getMyRsvp(event.id).then(({ data }) => setKebabVisitDate(data?.preferred_visit_date ?? null))
    } else {
      setKebabMenuPosition(null)
      setKebabVisitDate(null)
    }
  }, [showKebabMenu, event.id])

  useEffect(() => {
    if (!showKebabMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const inTrigger = kebabMenuRef.current?.contains(target)
      const inPortal = kebabPortalRef.current?.contains(target)
      if (!inTrigger && !inPortal) setShowKebabMenu(false)
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [showKebabMenu])

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!canSwipeRsvp) return
    const touch = e.touches[0]
    touchStartXRef.current = touch.clientX
    touchStartYRef.current = touch.clientY
    didSwipeRef.current = false
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!canSwipeRsvp) return
    if (touchStartXRef.current == null || touchStartYRef.current == null) return
    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartXRef.current
    const dy = touch.clientY - touchStartYRef.current
    touchStartXRef.current = null
    touchStartYRef.current = null

    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return
    didSwipeRef.current = true
    if (dx < 0) setShowMobileSwipeRsvp(true)
    else setShowMobileSwipeRsvp(false)
  }

  const ringClass = isMissed
      ? 'ring-2 ring-amber-400 ring-offset-2'
      : isWishlist
        ? 'ring-2 ring-sky-400 ring-offset-2'
        : ''

  const watchBorderClass = isMissed
    ? 'border-2 border-dashed border-amber-300'
    : isWishlist
      ? 'border-2 border-dashed border-sky-300'
      : isOwnNotGoing
        ? 'border-2 border-red-400'
        : 'border border-transparent'
  const kebabHasItems = (!isReminder) || (!!onClone) || (!!onDelete && isOrganizer)
  const compactAccentClass: Record<string, string> = {
    personal: 'border-l-violet-500',
    friends: 'border-l-amber-500',
    family: 'border-l-emerald-500',
    group: 'border-l-blue-500',
  }

  const modals = (
    <>
      <EventDetailsModal
        event={event}
        isOpen={showViewModal}
        onClose={() => setShowViewModal(false)}
        onClone={onClone}
        onAcknowledged={() => setWatchTask((t) => t ? { ...t, has_unread_update: false } : null)}
        showRSVP={showRSVP}
        showMemories={showMemories}
        rsvpVersion={rsvpVersion}
        onRsvpVersionChange={() => setRsvpVersion((v) => v + 1)}
      />
      {showShareModal && (
        <EventShareModal
          event={event}
          onClose={() => setShowShareModal(false)}
          onSuccess={() => { setShowShareModal(false); onShareSuccess?.() }}
        />
      )}
      {showInviteModal && (
        <EventInviteModal event={event} onClose={() => setShowInviteModal(false)} />
      )}
      {parentEvent && (
        <EventDetailsModal
          event={parentEvent}
          isOpen={true}
          onClose={() => setParentEvent(null)}
          showRSVP={false}
          showMemories={false}
          rsvpVersion={parentRsvpVersion}
          onRsvpVersionChange={() => setParentRsvpVersion((v) => v + 1)}
        />
      )}
    </>
  )

  if (viewMode === 'compact') {
    return (
      <>
        <div className={`relative overflow-hidden rounded-lg${dimmed ? ' opacity-70' : ''}`}>
          {canSwipeRsvp && (
            <div
              className={`sm:hidden absolute inset-y-0 right-0 w-[20%] bg-indigo-50 border border-indigo-200 border-l-0 rounded-r-lg p-1.5 transition-opacity ${
                showMobileSwipeRsvp ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-full flex flex-col justify-center">
                <RSVPButton
                  eventId={event.id}
                  eventStartDate={event.start_date}
                  layout="vertical"
                  onAfterSet={() => setRsvpVersion((v) => v + 1)}
                />
              </div>
            </div>
          )}
          <article
            role="button"
            tabIndex={0}
            onClick={() => {
              if (didSwipeRef.current) {
                didSwipeRef.current = false
                return
              }
              if (showMobileSwipeRsvp) {
                setShowMobileSwipeRsvp(false)
                return
              }
              setShowViewModal(true)
            }}
            onKeyDown={(e) => e.key === 'Enter' && setShowViewModal(true)}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            className={`bg-gradient-to-br from-white to-indigo-50/40 rounded-lg shadow hover:shadow-md transition-all duration-200 max-w-full min-w-0 cursor-pointer ${isImmediateNext ? 'border-l-[6px]' : 'border-l-4'} ${compactAccentClass[event.event_type] ?? 'border-l-indigo-500'} ${ringClass} ${watchBorderClass} ${showMobileSwipeRsvp ? '-translate-x-[20%] sm:translate-x-0' : 'translate-x-0'}`}
          >
            <div className="p-2.5 sm:p-3">
              <div className="flex items-start justify-between gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {isReminder && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium uppercase tracking-wide bg-slate-100 text-slate-600">
                        <Bell className="h-3 w-3" /> Reminder
                      </span>
                    )}
                    {!isReminder && <StatusBadge status={event.event_status} size="xs" />}
                    {!isReminder && showRSVP && !isWatching && (
                      <MyRsvpBadge eventId={event.id} showRSVP={showRSVP} refreshTrigger={rsvpVersion} />
                    )}
                    {event.parent_event_id && resolvedParentTitle && (
                      <button
                        type="button"
                        onClick={handleViewParent}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-violet-100 text-violet-800 hover:bg-violet-200 max-w-[160px] truncate"
                      >
                        <Layers className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{resolvedParentTitle}</span>
                      </button>
                    )}
                    {event.enrollment_url && !isReminder ? (
                      <a
                        href={event.enrollment_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm font-semibold text-indigo-800 hover:text-indigo-900 hover:underline break-words"
                      >
                        {event.title}
                      </a>
                    ) : (
                      <h3 className="text-sm font-semibold text-slate-900 break-words">{event.title}</h3>
                    )}
                    {updateBadge}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-700">
                    <span className="inline-flex items-center min-w-0">
                      <Calendar className="h-3 w-3 mr-1 flex-shrink-0 text-indigo-600" />
                      <span className="break-words">
                        {format(new Date(event.start_date), 'PP')}
                        {(() => { const d = new Date(event.start_date); return (d.getHours() !== 0 || d.getMinutes() !== 0) ? ` · ${format(d, 'p')}` : '' })()}
                        {event.end_date && format(new Date(event.end_date), 'yyyy-MM-dd') !== format(new Date(event.start_date), 'yyyy-MM-dd') && ` – ${format(new Date(event.end_date), 'PP')}`}
                      </span>
                    </span>
                    {event.location && (
                      <span className="inline-flex items-center min-w-0">
                        <MapPin className="h-3 w-3 mr-1 flex-shrink-0 text-rose-500" />
                        <span className="truncate">{event.location}</span>
                      </span>
                    )}
                  </div>
                  {event.sessions_summary && (
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-violet-700">
                      <CalendarDays className="h-3 w-3 flex-shrink-0" />
                      <span>
                        {event.sessions_summary.past}/{event.sessions_summary.total} sessions
                        {event.sessions_summary.next_date && ` · Next: ${format(new Date(event.sessions_summary.next_date), 'MMM d')}`}
                        {event.sessions_summary.missed > 0 && ` · ${event.sessions_summary.missed} missed`}
                      </span>
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {!isReminder && showRSVP && !isWatching && (
                      <CompactRsvpInitials
                        eventId={event.id}
                        showRSVP={showRSVP}
                        refreshTrigger={rsvpVersion}
                      />
                    )}
                    {showRSVP && !isWatching && event.end_date && new Date(event.start_date).getTime() < new Date(event.end_date).getTime() && (
                      <span className="text-[11px]">
                        <PreferredVisitDate
                          eventId={event.id}
                          startDate={event.start_date}
                          endDate={event.end_date}
                          createdBy={event.created_by}
                          showPicker={false}
                          inline
                        />
                      </span>
                    )}
                    {event.hashtags && event.hashtags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {event.hashtags.slice(0, 4).map((tag) => (
                          <button
                            type="button"
                            key={tag}
                            onClick={(e) => {
                              e.stopPropagation()
                              onHashtagClick?.(tag)
                            }}
                            className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-200"
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                  <span
                    className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${
                      sharedFamily ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-400 border border-slate-200'
                    }`}
                    title={sharedFamily ? 'Shared with family' : 'Not shared with family'}
                  >
                    <Users className="h-3 w-3" />
                  </span>
                  <span
                    className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${
                      sharedFriends ? 'bg-rose-100 text-rose-700 border border-rose-200' : 'bg-slate-100 text-slate-400 border border-slate-200'
                    }`}
                    title={sharedFriends ? 'Shared with friends' : 'Not shared with friends'}
                  >
                    <Handshake className="h-3 w-3" />
                  </span>
                  {!sharedFamily && !sharedFriends && (
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-600 border border-slate-200"
                      title="Private"
                    >
                      <Lock className="h-3 w-3" />
                    </span>
                  )}
                  {showActions && isOrganizer && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowShareModal(true) }}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-600 hover:bg-gray-100"
                      aria-label="Share"
                    >
                      <Share2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {showActions && !isOrganizer && (
                    <a
                      href={getWhatsAppShareUrl(event)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[#25D366] hover:bg-[#25D366]/10"
                      aria-label="Share to WhatsApp"
                      title="Share to WhatsApp"
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {onEdit && isOrganizer && (
                    <button
                      type="button"
                      onClick={() => onEdit(event)}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-indigo-600 hover:bg-indigo-50"
                      aria-label="Edit event"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {showActions && isOrganizer && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowInviteModal(true) }}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-600 hover:bg-gray-100"
                      aria-label="Invite"
                      title="Invite"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {kebabHasItems && (
                    <div className="relative" ref={kebabMenuRef}>
                      <button
                        ref={kebabTriggerRef}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setShowKebabMenu((v) => !v) }}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-600 hover:bg-gray-100"
                        aria-label="More actions"
                        title="More actions"
                        aria-expanded={showKebabMenu}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </article>
        </div>
        {showKebabMenu &&
          kebabMenuPosition &&
          createPortal(
            <div
              ref={kebabPortalRef}
              className="fixed z-[9999] py-1 w-48 bg-white rounded-md shadow-lg border border-gray-200"
              style={{ top: kebabMenuPosition.top, left: kebabMenuPosition.left }}
              onClick={(e) => e.stopPropagation()}
            >
              {!isReminder && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      downloadIcs(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)
                      setShowKebabMenu(false)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Download className="h-4 w-4 text-gray-500" />
                    Download .ics
                  </button>
                  <a
                    href={getGoogleCalendarAddUrl(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setShowKebabMenu(false)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <CalendarPlus className="h-4 w-4 text-gray-500" />
                    Google Calendar
                  </a>
                  <a
                    href={getOutlookCalendarAddUrl(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setShowKebabMenu(false)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <CalendarPlus className="h-4 w-4 text-gray-500" />
                    Outlook
                  </a>
                </>
              )}
              {!isReminder && (onClone || (onDelete && isOrganizer)) && (
                <div className="my-1 border-t border-gray-100" />
              )}
              {onClone && (
                <button
                  type="button"
                  onClick={() => { onClone(event); setShowKebabMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Copy className="h-4 w-4 text-violet-700" />
                  Clone
                </button>
              )}
              {onDelete && isOrganizer && (
                <button
                  type="button"
                  onClick={() => { onDelete(event.id); setShowKebabMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              )}
            </div>,
            document.body
          )}
        {modals}
      </>
    )
  }

  return (
    <>
    <article
      role="button"
      tabIndex={0}
      onClick={() => setShowViewModal(true)}
      onKeyDown={(e) => e.key === 'Enter' && setShowViewModal(true)}
      className={`bg-white rounded-lg shadow overflow-hidden hover:shadow-md transition-shadow flex flex-col sm:flex-row max-w-full min-w-0 cursor-pointer ${isImmediateNext ? `border-l-[6px] ${compactAccentClass[event.event_type] ?? 'border-l-indigo-500'}` : ''} ${ringClass} ${watchBorderClass}${dimmed ? ' opacity-70' : ''}`}
    >
      {/* Left: cover photo or placeholder — 1/3 on desktop, full width on mobile */}
      <div className="w-full sm:w-1/3 flex-shrink-0 aspect-[2/1] sm:aspect-[4/3] bg-gray-100 relative overflow-hidden min-w-0">
        {showImage && imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className={`w-full h-full bg-gradient-to-br ${gradient} flex items-center justify-center`}>
            {isReminder ? (
              <Bell className="w-10 h-10 sm:w-12 sm:h-12 text-white/80" aria-hidden />
            ) : (
              <CalendarDays className="w-10 h-10 sm:w-12 sm:h-12 text-white/80" aria-hidden />
            )}
          </div>
        )}
      </div>
      {/* Right: event details — 2/3 on desktop */}
      <div className="flex-1 min-w-0 p-3 sm:p-4 flex flex-col">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              {isReminder && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium uppercase tracking-wide bg-slate-100 text-slate-600">
                  <Bell className="h-3 w-3" /> Reminder
                </span>
              )}
              {!isReminder && <StatusBadge status={event.event_status} size="sm" />}
              {!isReminder && showRSVP && !isWatching && (
                <MyRsvpBadge eventId={event.id} showRSVP={showRSVP} refreshTrigger={rsvpVersion} />
              )}
              <h3 className="text-base sm:text-lg font-semibold text-gray-900 break-words">{event.title}</h3>
              {updateBadge}
              {event.parent_title && (
                <button
                  type="button"
                  onClick={handleViewParent}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-800 hover:bg-violet-200 max-w-[200px] truncate"
                >
                  <Layers className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{event.parent_title}</span>
                </button>
              )}
            </div>
            {event.sessions_summary && (
              <div className="flex items-center gap-1.5 text-xs text-violet-700 mb-1">
                <CalendarDays className="h-3.5 w-3.5 flex-shrink-0" />
                <span>
                  {event.sessions_summary.past}/{event.sessions_summary.total} sessions completed
                  {event.sessions_summary.next_date && ` · Next: ${format(new Date(event.sessions_summary.next_date), 'EEE MMM d')}`}
                  {event.sessions_summary.missed > 0 && ` · ${event.sessions_summary.missed} missed`}
                </span>
              </div>
            )}
            {event.description && (
              <p className="text-gray-600 text-xs sm:text-sm mb-2 line-clamp-1">{event.description}</p>
            )}
          </div>
          {(showActions || onClone || !isReminder) && (
            <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
              {showActions && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowViewModal(true)}
                    className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-gray-600 hover:bg-gray-100"
                    aria-label="View details"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  {isOrganizer && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowShareModal(true) }}
                      className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-gray-600 hover:bg-gray-100"
                      aria-label="Share"
                    >
                      <Share2 className="h-4 w-4" />
                    </button>
                  )}
                  {showActions && !isOrganizer && (
                    <a
                      href={getWhatsAppShareUrl(event)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-[#25D366] hover:bg-[#25D366]/10"
                      aria-label="Share to WhatsApp"
                      title="Share to WhatsApp"
                    >
                      <MessageCircle className="h-4 w-4" />
                    </a>
                  )}
                  {isOrganizer && (
                    <button
                      type="button"
                      onClick={() => setShowInviteModal(true)}
                      className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-gray-600 hover:bg-gray-100"
                      aria-label="Invite"
                    >
                      <UserPlus className="h-4 w-4" />
                    </button>
                  )}
                </>
              )}
              {onClone && (
                <button
                  type="button"
                  onClick={() => onClone(event)}
                  className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-violet-700 hover:bg-violet-50"
                  aria-label="Clone event"
                  title="Clone event"
                >
                  <Copy className="h-4 w-4" />
                </button>
              )}
              {onEdit && isOrganizer && (
                <button
                  type="button"
                  onClick={() => onEdit(event)}
                  className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-indigo-600 hover:bg-indigo-50"
                  aria-label="Edit event"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              {onDelete && isOrganizer && (
                <button
                  type="button"
                  onClick={() => onDelete(event.id)}
                  className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-red-600 hover:bg-red-50"
                  aria-label="Delete event"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              {!isReminder && (
                <div className="relative" ref={kebabMenuRef}>
                  <button
                    ref={kebabTriggerRef}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowKebabMenu((v) => !v) }}
                    className="inline-flex items-center justify-center w-9 h-9 min-h-[40px] min-w-[40px] rounded-md text-emerald-600 hover:bg-emerald-50"
                    aria-label="Add to calendar"
                    title="Add to calendar"
                    aria-expanded={showKebabMenu}
                  >
                    <CalendarPlus className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-1.5 min-w-0">
          {isWatching && nextExpectedDate && (
            <div className="text-xs text-gray-500">
              Next expected: {format(new Date(nextExpectedDate), 'MMM yyyy')}
              <span className="ml-1.5 text-gray-400">(originally {format(new Date(event.start_date), 'MMM d, yyyy')})</span>
            </div>
          )}
          <div className="flex items-center text-xs sm:text-sm text-gray-600 min-w-0">
            <Calendar className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
            <span className="min-w-0 break-words">
              {format(new Date(event.start_date), 'PPp')}
              {event.end_date && format(new Date(event.end_date), 'yyyy-MM-dd') !== format(new Date(event.start_date), 'yyyy-MM-dd') && ` – ${format(new Date(event.end_date), 'PPp')}`}
            </span>
          </div>
          {event.hashtags && event.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {event.hashtags.slice(0, 5).map((tag) => (
                <button
                  type="button"
                  key={tag}
                  onClick={(e) => {
                    e.stopPropagation()
                    onHashtagClick?.(tag)
                  }}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-100"
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
          {event.location && (
            <div className="flex items-center text-xs sm:text-sm text-gray-600 min-w-0">
              <MapPin className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
              <a
                href={`https://www.google.com/maps/search/?q=${encodeURIComponent(event.location)}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="hover:underline break-words min-w-0"
              >
                {event.location}
              </a>
            </div>
          )}
          {!isReminder && (showRSVP && !isWatching && event.end_date && new Date(event.start_date).getTime() < new Date(event.end_date).getTime() || event.enrollment_deadline || event.enrollment_start_date || event.enrollment_url) && (
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs min-w-0">
              {showRSVP && !isWatching && event.end_date && new Date(event.start_date).getTime() < new Date(event.end_date).getTime() && (
                <PreferredVisitDate eventId={event.id} startDate={event.start_date} endDate={event.end_date} createdBy={event.created_by} showPicker={false} inline />
              )}
              {showRSVP && !isWatching && event.end_date && new Date(event.start_date).getTime() < new Date(event.end_date).getTime() && (event.enrollment_deadline || event.enrollment_start_date || event.enrollment_url) && (
                <span className="text-gray-400 flex-shrink-0">·</span>
              )}
              {event.enrollment_deadline || event.enrollment_start_date ? (
                <span className="text-orange-600">
                  {event.enrollment_start_date && event.enrollment_deadline
                    ? `Registration ${format(new Date(event.enrollment_start_date), 'MMM d')} – ${format(new Date(event.enrollment_deadline), 'MMM d, yyyy')}`
                    : event.enrollment_deadline
                      ? `Register by ${format(new Date(event.enrollment_deadline), 'PP')}`
                      : `Registration from ${format(new Date(event.enrollment_start_date!), 'PP')}`}
                </span>
              ) : !event.enrollment_url ? (
                <span className="text-green-700">No registration required</span>
              ) : null}
              {event.enrollment_url && (
                <>
                  <span className="text-gray-400 flex-shrink-0">·</span>
                  <a
                    href={event.enrollment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline truncate min-w-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Event link
                  </a>
                </>
              )}
            </div>
          )}
          <div className="flex items-center flex-wrap gap-2 pt-1.5 border-t border-gray-100 text-xs">
            {sharedFamily && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                <Users className="h-3 w-3" />
                Family
              </span>
            )}
            {sharedFriends && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                <Handshake className="h-3 w-3" />
                Friends
              </span>
            )}
            {!sharedFamily && !sharedFriends && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                <Lock className="h-3 w-3" />
                Private
              </span>
            )}
          </div>
          {!isReminder && showWatchButton && event.enrollment_url && (event.event_status === 'going') && (
            <div className="mt-2 pt-2 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
              <WatchForNextYearButton event={event} />
            </div>
          )}
          {!isReminder && showRSVP && !isWatching && (
            <div className="mt-2 pt-2 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
              <RSVPButton
                eventId={event.id}
                eventStartDate={event.start_date}
                onAfterSet={() => setRsvpVersion((v) => v + 1)}
              />
              <div className="mt-2">
                <RSVPList eventId={event.id} createdBy={event.created_by} refreshTrigger={rsvpVersion} />
              </div>
            </div>
          )}
          {showMemories && !isReminder && (
            <div className="mt-2 pt-2 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
              <EventMemoryComponent eventId={event.id} />
            </div>
          )}
        </div>
      </div>
    </article>

    {showKebabMenu &&
      kebabMenuPosition &&
      createPortal(
        <div
          ref={kebabPortalRef}
          className="fixed z-[9999] py-1 w-48 bg-white rounded-md shadow-lg border border-gray-200"
          style={{ top: kebabMenuPosition.top, left: kebabMenuPosition.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              downloadIcs(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)
              setShowKebabMenu(false)
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-4 w-4 text-gray-500" />
            Download .ics
          </button>
          <a
            href={getGoogleCalendarAddUrl(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setShowKebabMenu(false)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <CalendarPlus className="h-4 w-4 text-gray-500" />
            Google Calendar
          </a>
          <a
            href={getOutlookCalendarAddUrl(event, kebabVisitDate ? { visitDate: kebabVisitDate } : undefined)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setShowKebabMenu(false)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <CalendarPlus className="h-4 w-4 text-gray-500" />
            Outlook
          </a>
        </div>,
        document.body
      )}
    {modals}
    </>
  )
}
