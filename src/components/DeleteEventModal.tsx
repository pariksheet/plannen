import { useState } from 'react'
import type { Event } from '../types/event'
import { deleteEvent, deleteEventSeries } from '../services/eventService'
import { Modal } from './Modal'

interface Props {
  /** The event pending deletion; `null` keeps the modal closed. */
  event: Event | null
  onClose: () => void
  /** Called after a successful delete with the targeted event and what was removed. */
  onDeleted: (event: Event, scope: 'single' | 'series') => void
  /** Called with a human-readable message when a delete fails. */
  onError: (message: string) => void
}

/**
 * Delete confirmation for an event. When the event belongs to a recurring
 * series it offers a "Delete series" choice (and, for a single occurrence,
 * "Delete this event" too) instead of the plain single-event confirm.
 *
 * Series shape: a recurrence master carries `recurrence_rule`; its occurrences
 * carry `parent_event_id` pointing back at the master.
 */
export function DeleteEventModal({ event, onClose, onDeleted, onError }: Props) {
  const [busy, setBusy] = useState(false)
  if (!event) return null

  const isChild = !!event.parent_event_id
  const isParent = !!event.recurrence_rule && !event.parent_event_id
  const inSeries = isChild || isParent
  const masterId = event.parent_event_id ?? event.id

  const run = async (scope: 'single' | 'series') => {
    if (busy) return
    setBusy(true)
    const { error } = scope === 'series'
      ? await deleteEventSeries(masterId)
      : await deleteEvent(event.id)
    setBusy(false)
    if (error) { onError(error.message); return }
    onClose()
    onDeleted(event, scope)
  }

  return (
    <Modal isOpen onClose={onClose} title={inSeries ? 'Delete repeating event?' : 'Delete event?'}>
      <div className="space-y-4">
        <p className="text-gray-700">
          {isParent
            ? 'This is a repeating event. Deleting it removes the whole series — every session.'
            : isChild
              ? 'This event is part of a repeating series. Delete just this one, or the whole series?'
              : 'This event will be permanently deleted.'}
        </p>
        <div className="flex flex-wrap justify-end gap-2 sm:gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] px-4 py-2.5 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          {isChild && (
            <button
              type="button"
              onClick={() => void run('single')}
              disabled={busy}
              className="min-h-[44px] px-4 py-2.5 text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors disabled:opacity-50"
            >
              Delete this event
            </button>
          )}
          <button
            type="button"
            onClick={() => void run(inSeries ? 'series' : 'single')}
            disabled={busy}
            className="min-h-[44px] px-4 py-2.5 text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {inSeries ? 'Delete series' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
