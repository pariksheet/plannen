import { useEffect, useState } from 'react'
import { Calendar, Layers, Link as LinkIcon, Mail, MapPin, Pencil, Users } from 'lucide-react'
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
import { dbClient } from '../lib/dbClient'
import type { EventProvenanceRow, EventRow } from '../lib/dbClient/types'
import { MuteSyncDialog, type MuteSyncConfirmSpec } from './MuteSyncDialog'
import { SweepMatchesDialog } from './SweepMatchesDialog'

interface EventDetailsModalProps {
  event: Event
  isOpen: boolean
  onClose: () => void
  onClone?: (event: Event) => void
  /** When provided, renders an Edit button that closes the modal and hands the event off to edit mode. */
  onEdit?: (event: Event) => void
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
  onEdit,
  onAcknowledged,
  showRSVP = true,
  showMemories = false,
  rsvpVersion,
  onRsvpVersionChange,
}: EventDetailsModalProps) {
  const isReminder = event.event_kind === 'reminder'
  const isWatching = event.event_status === 'watching' || event.event_status === 'missed'
  const sharedFriends = (event.shared_with_friends ?? 'none') !== 'none'
  const sharingLabel =
    event.shared_with_friends === 'all'
      ? 'Shared with all friends'
      : event.shared_with_friends === 'selected'
        ? 'Shared with selected friends'
        : sharedFriends
          ? 'Shared'
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

  const isSync = event.hashtags?.includes('mbsync') ?? false
  const [provenance, setProvenance] = useState<EventProvenanceRow | null>(null)
  const [muteOpen, setMuteOpen] = useState(false)
  const [sweepMatches, setSweepMatches] = useState<EventRow[] | null>(null)

  useEffect(() => {
    if (!isOpen || !isSync) return
    let cancelled = false
    dbClient.events.getProvenance(event.id).then((row) => {
      if (!cancelled) setProvenance(row)
    }).catch(() => {
      if (!cancelled) setProvenance(null)
    })
    return () => { cancelled = true }
  }, [isOpen, isSync, event.id])

  async function handleMuteConfirm(spec: MuteSyncConfirmSpec) {
    setMuteOpen(false)
    try {
      await dbClient.ignoreRules.add({
        adapter_id: provenance?.adapter_id ?? 'gmail',
        kind: spec.kind,
        pattern: spec.pattern,
        subject_keyword: spec.subject_keyword,
        source_event_id: event.id,
        source_message_id: provenance?.source_message_id ?? null,
      })
      if (spec.alsoDeleteCurrent) {
        await dbClient.events.delete(event.id)
      }
      const matches = await dbClient.ignoreRules.findMatchingMbsyncEvents({
        kind: spec.kind,
        pattern: spec.pattern,
        subject_keyword: spec.subject_keyword,
      })
      const filtered = spec.alsoDeleteCurrent ? matches.filter((m) => m.id !== event.id) : matches
      if (filtered.length > 0) {
        setSweepMatches(filtered)
      } else if (spec.alsoDeleteCurrent) {
        onClose()
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to mute')
    }
  }

  async function handleSweepDelete(ids: string[]) {
    await Promise.all(ids.map((id) => dbClient.events.delete(id)))
    setSweepMatches(null)
    onClose()
  }

  async function handleViewParent() {
    if (!event.parent_event_id) return
    const { data } = await getEvent(event.parent_event_id)
    if (data) setParentEvent(data)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={event.title}
      headerActions={onEdit && (
        <button
          type="button"
          onClick={() => { onClose(); onEdit(event) }}
          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors flex-shrink-0"
          aria-label="Edit event"
          title="Edit event"
        >
          <Pencil className="h-5 w-5" />
        </button>
      )}
    >
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
        {(() => {
          // Strip the leading "Gmail-ID: <id>\n\n" prefix that the sync agent
          // writes — it's user-facing noise; the ID is surfaced via the Gmail
          // icon in the Source section below.
          const cleanDescription = event.description?.replace(/^Gmail-ID:\s*\S+\s*\n*/, '').trim()
          return cleanDescription ? (
            <p className="text-gray-700 text-sm whitespace-pre-wrap">{cleanDescription}</p>
          ) : null
        })()}
        <div className="space-y-2 text-sm">
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" />
            <span className="text-gray-700">
              {format(new Date(event.start_date), 'EEE, PPp')}
              {event.end_date && ` – ${format(new Date(event.end_date), 'EEE, PPp')}`}
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
        {isSync && (
          <div className="pt-4 border-t border-gray-200">
            <div className="flex items-start gap-2 text-sm">
              <Mail className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-700">Added by mailbox sync</p>
                {provenance ? (
                  <p className="text-gray-600 break-all">From: {provenance.sender_display}</p>
                ) : (
                  <p className="text-gray-500 italic">Source unknown</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {(() => {
                    // Prefer provenance.source_message_id; for legacy #mbsync events
                    // without provenance, parse Gmail-ID from the description prefix.
                    const messageId = provenance?.source_message_id
                      ?? event.description?.match(/^Gmail-ID:\s*(\S+)/)?.[1]
                      ?? null
                    return messageId ? (
                      <a
                        href={`https://mail.google.com/mail/u/0/#inbox/${messageId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open original email in Gmail"
                        aria-label="Open original email in Gmail"
                        className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] p-2 rounded-md border border-gray-300 hover:bg-red-50 hover:border-red-300 text-red-600"
                      >
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                          <path d="M22 6.5v11c0 .8-.7 1.5-1.5 1.5H18V8.6l-6 4.4-6-4.4V19H3.5C2.7 19 2 18.3 2 17.5v-11C2 5.7 2.7 5 3.5 5h.3l8.2 6 8.2-6h.3c.8 0 1.5.7 1.5 1.5z" />
                        </svg>
                      </a>
                    ) : null
                  })()}
                  <button
                    type="button"
                    onClick={() => setMuteOpen(true)}
                    className="min-h-[44px] px-3 py-1 text-sm rounded-md border border-gray-300 hover:bg-gray-50"
                  >
                    Mute…
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {!isReminder && showRSVP && !isWatching && (
          <div className="pt-4 border-t border-gray-200 space-y-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Your response</p>
            <RSVPButton
              eventId={event.id}
              eventStartDate={event.start_date}
              onAfterSet={onRsvpVersionChange}
            />
            {event.end_date && (() => {
              const s = new Date(event.start_date)
              const e = new Date(event.end_date)
              return s.getFullYear() !== e.getFullYear()
                || s.getMonth() !== e.getMonth()
                || s.getDate() !== e.getDate()
            })() && (
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
      <MuteSyncDialog
        isOpen={muteOpen}
        onClose={() => setMuteOpen(false)}
        onConfirm={handleMuteConfirm}
        eventId={event.id}
        provenance={provenance}
        eventDescription={event.description}
      />
      {sweepMatches !== null && (
        <SweepMatchesDialog
          isOpen
          matches={sweepMatches.map((e) => ({ id: e.id, title: e.title, start_date: e.start_date }))}
          onClose={() => { setSweepMatches(null); onClose() }}
          onDelete={handleSweepDelete}
        />
      )}
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

