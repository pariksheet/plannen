import { useEffect, useState } from 'react'
import { Calendar, Layers, Link as LinkIcon, MapPin, Users } from 'lucide-react'
import { format } from 'date-fns'
import { Event } from '../types/event'
import { Modal } from './Modal'
import { RSVPButton } from './RSVPButton'
import { RSVPList } from './RSVPList'
import { PreferredVisitDate } from './PreferredVisitDate'
import { EventMemoryComponent } from './EventMemory'
import { EventStorySection } from './EventStorySection'
import { getEventWatchTask, acknowledgeWatchUpdate } from '../services/agentTaskService'
import { getEvent } from '../services/eventService'

interface EventDetailsModalProps {
  event: Event
  isOpen: boolean
  onClose: () => void
  onClone?: (event: Event) => void
  onAcknowledged?: () => void
  showRSVP?: boolean
  showMemories?: boolean
  rsvpVersion: number
  onRsvpVersionChange: () => void
}

export function EventDetailsModal({
  event,
  isOpen,
  onClose,
  onClone,
  onAcknowledged,
  showRSVP = true,
  showMemories = false,
  rsvpVersion,
  onRsvpVersionChange,
}: EventDetailsModalProps) {
  const isReminder = event.event_kind === 'reminder'
  const isWatching = event.event_status === 'watching' || event.event_status === 'missed'
  const sharedFamily = event.shared_with_family ?? false
  const sharedFriends = (event.shared_with_friends ?? 'none') !== 'none'
  const sharingLabel = sharedFamily && sharedFriends
    ? 'Shared with family & friends'
    : sharedFamily
      ? 'Shared with family'
      : event.shared_with_friends === 'all'
        ? 'Shared with all friends'
        : event.shared_with_friends === 'selected'
          ? 'Shared with selected friends'
          : 'Private'

  useEffect(() => {
    if (!isOpen || !event.enrollment_url) return
    getEventWatchTask(event.id).then((task) => {
      if (task?.has_unread_update) {
        acknowledgeWatchUpdate(task.id).then(() => onAcknowledged?.())
      }
    })
  }, [isOpen, event.id, event.enrollment_url])

  const [parentEvent, setParentEvent] = useState<Event | null>(null)
  const [parentTitle, setParentTitle] = useState<string | null>(event.parent_title ?? null)

  useEffect(() => {
    setParentTitle(event.parent_title ?? null)
    if (event.parent_title || !event.parent_event_id) return
    let cancelled = false
    getEvent(event.parent_event_id).then(({ data }) => {
      if (!cancelled && data) setParentTitle(data.title)
    })
    return () => { cancelled = true }
  }, [event.id, event.parent_event_id, event.parent_title])

  async function handleViewParent() {
    if (!event.parent_event_id) return
    const { data } = await getEvent(event.parent_event_id)
    if (data) setParentEvent(data)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={event.title}>
      <div className="space-y-4">
        {parentTitle && event.parent_event_id && (
          <button
            type="button"
            onClick={handleViewParent}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-100 text-violet-800 hover:bg-violet-200 max-w-full"
          >
            <Layers className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{parentTitle}</span>
          </button>
        )}
        {event.description && (
          <p className="text-gray-700 text-sm whitespace-pre-wrap">{event.description}</p>
        )}
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" />
            <span className="text-gray-700">
              {format(new Date(event.start_date), 'PPp')}
              {event.end_date && ` – ${format(new Date(event.end_date), 'PPp')}`}
            </span>
          </div>
          {event.location && (
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" />
              <a
                href={`https://www.google.com/maps/search/?q=${encodeURIComponent(event.location)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-700 hover:underline break-words"
              >
                {event.location}
              </a>
            </div>
          )}
          {!isReminder && (event.enrollment_deadline || event.enrollment_start_date) && (
            <div className="flex items-start gap-2 text-orange-700">
              <Calendar className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>
                {event.enrollment_start_date && event.enrollment_deadline
                  ? `Registration ${format(new Date(event.enrollment_start_date), 'MMM d, yyyy')} – ${format(new Date(event.enrollment_deadline), 'MMM d, yyyy')}`
                  : event.enrollment_deadline
                    ? `Register by ${format(new Date(event.enrollment_deadline), 'PPp')}`
                    : `Registration from ${format(new Date(event.enrollment_start_date!), 'PPp')}`}
              </span>
            </div>
          )}
          {!isReminder && !event.enrollment_url && !event.enrollment_deadline && !event.enrollment_start_date && (
            <div className="flex items-start gap-2 text-green-700">
              <Calendar className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>No registration required</span>
            </div>
          )}
          {!isReminder && event.enrollment_url && (
            <div className="flex items-start gap-2">
              <LinkIcon className="h-4 w-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <a
                href={event.enrollment_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline break-all"
              >
                Event link
              </a>
              <span className="text-gray-500 text-xs break-all">({event.enrollment_url})</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-gray-500 pt-2 border-t border-gray-100">
            <Users className="h-4 w-4" />
            <span>{sharingLabel}</span>
          </div>
          {event.hashtags && event.hashtags.length > 0 && (
            <div className="pt-2 flex flex-wrap gap-1">
              {event.hashtags.slice(0, 5).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-100"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {!isReminder && showRSVP && !isWatching && (
          <div className="pt-4 border-t border-gray-200 space-y-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Your response</p>
            <RSVPButton
              eventId={event.id}
              eventStartDate={event.start_date}
              onAfterSet={onRsvpVersionChange}
            />
            {event.end_date && new Date(event.start_date).getTime() < new Date(event.end_date).getTime() && (
              <PreferredVisitDate
                eventId={event.id}
                startDate={event.start_date}
                endDate={event.end_date}
                createdBy={event.created_by}
                showPicker
              />
            )}
            <div className="mt-3">
              <RSVPList eventId={event.id} createdBy={event.created_by} refreshTrigger={rsvpVersion} />
            </div>
          </div>
        )}
        {showMemories && !isReminder && (
          <div className="pt-4 border-t border-gray-200">
            <EventMemoryComponent eventId={event.id} />
            <EventStorySection eventId={event.id} />
          </div>
        )}
        {onClone && (
          <div className="pt-4 border-t border-gray-200 flex justify-end">
            <button
              type="button"
              onClick={() => onClone(event)}
              className="px-4 py-2 rounded-md border border-indigo-600 text-indigo-700 font-medium hover:bg-indigo-50"
            >
              Clone event
            </button>
          </div>
        )}
      </div>
      {parentEvent && (
        <EventDetailsModal
          event={parentEvent}
          isOpen={!!parentEvent}
          onClose={() => setParentEvent(null)}
          showRSVP={showRSVP}
          showMemories={showMemories}
          rsvpVersion={rsvpVersion}
          onRsvpVersionChange={onRsvpVersionChange}
        />
      )}
    </Modal>
  )
}

