import { useState } from 'react'
import { Briefcase, ChevronUp, ChevronDown, ListChecks, Plus } from 'lucide-react'
import type { Event } from '../types/event'
import type { ChecklistRow } from '../lib/dbClient/types'
import type { NewChecklistItem } from '../services/checklistService'
import { EventList } from './EventList'
import { ChecklistCreateForm } from './ChecklistCreateForm'
import { deleteContainer, syncTripSharing } from '../services/containerService'

interface TripsSectionProps {
  /** Trip containers (event_kind='container') to list. */
  trips: Event[]
  /** Resolve a trip's child events/todos (events whose group_id === tripId). */
  childrenOf: (tripId: string) => Event[]
  /** Open the trip (and child events) — usually the parent's edit handler. */
  onEditTrip: (event: Event) => void
  /** Delete a child event by id (the parent's event-delete handler). */
  onDeleteEvent: (id: string) => void
  /** Reload after any mutation (share / delete trip / child change). */
  onChange: () => void
  onToggleTodo: (event: Event) => void
  onConvertKind: (event: Event, kind: 'reminder' | 'todo') => void
  onHashtagClick: (tag: string) => void
  /** Whether the section starts expanded. Defaults to collapsed (My Plans). */
  defaultOpen?: boolean
  /** Resolve a trip's checklists (with done/total). When given, they render
   *  under the trip. Omit to hide checklists entirely. */
  checklistsOf?: (tripId: string) => ChecklistRow[]
  /** Open a checklist by id. When given, checklist rows become clickable. */
  onOpenChecklist?: (id: string) => void
  /** Create a checklist (parent owns the data + reload). When given, each trip
   *  shows a "+ Checklist" button that opens the create form pre-attached. */
  onCreateChecklist?: (input: { title: string; event_id: string | null; items: NewChecklistItem[] }) => Promise<void> | void
}

/**
 * The "Trips" section — a collapsible panel listing trip containers. Each trip
 * renders through the shared {@link EventList}/EventCard, identical to the
 * Watching panel and every other place an event appears, so a trip looks like
 * any other event card (badge, date, location, hashtags, action menu) and gets
 * the built-in "Events (N)" expander for its children. The only trip-specific
 * additions are wired through callbacks: deleting a trip removes just the
 * container (children stay), sharing a trip cascades its audience onto its
 * children, and each trip's checklists render in a footer beneath its card.
 * Shared verbatim between My Plans (MyFeed) and the starred-group Schedule view
 * (ScheduleOverview).
 */
export function TripsSection({
  trips, childrenOf, onEditTrip, onDeleteEvent, onChange,
  onToggleTodo, onConvertKind, onHashtagClick, defaultOpen = false,
  checklistsOf, onOpenChecklist, onCreateChecklist,
}: TripsSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [createForTrip, setCreateForTrip] = useState<Event | null>(null)
  if (trips.length === 0) return null

  const tripIds = new Set(trips.map((t) => t.id))

  // EventList delete is shared by trips and their expanded children: a trip
  // (container) removes just the container; a child is a normal event delete.
  const handleDelete = async (id: string) => {
    const trip = trips.find((t) => t.id === id)
    if (!trip) return onDeleteEvent(id)
    if (!window.confirm(`Delete the trip "${trip.title}"? Its events and to-dos stay — they're just no longer grouped.`)) return
    const { error } = await deleteContainer(trip.id)
    if (error) return
    onChange()
  }

  // Sharing a trip cascades its new audience onto its children. EventCard hands
  // back the shared event, so the cascade fires only for the trip — not when a
  // child event is shared on its own.
  const handleShareSuccess = (event: Event) => {
    void (async () => {
      if (tripIds.has(event.id)) {
        const childIds = childrenOf(event.id).map((e) => e.id)
        if (childIds.length) await syncTripSharing(event.id, childIds)
      }
      onChange()
    })()
  }

  const renderChecklist = (trip: Event) => {
    if (!checklistsOf && !onCreateChecklist) return null
    const checklists = checklistsOf?.(trip.id) ?? []
    return (
      <div className="mt-1 ml-1 space-y-1">
        {checklists.map((cl) => {
          const total = cl.total ?? 0
          const done = cl.done ?? 0
          const inner = (
            <>
              <ListChecks className="h-3.5 w-3.5 text-indigo-500 shrink-0" aria-hidden />
              <span className="truncate">{cl.title}</span>
              <span className="ml-auto text-gray-400 tabular-nums">{done}/{total}</span>
            </>
          )
          return onOpenChecklist ? (
            <button key={cl.id} type="button" onClick={() => onOpenChecklist(cl.id)} className="flex items-center gap-2 w-full text-left text-xs text-gray-700 rounded px-1.5 py-1 hover:bg-gray-50">{inner}</button>
          ) : (
            <div key={cl.id} className="flex items-center gap-2 w-full text-xs text-gray-600 px-1.5 py-1">{inner}</div>
          )
        })}
        {onCreateChecklist && (
          <button type="button" onClick={() => setCreateForTrip(trip)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 px-1.5 py-1">
            <Plus className="h-3.5 w-3.5" /> Checklist
          </button>
        )}
      </div>
    )
  }

  return (
    <div data-testid="trips-section" className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-gray-900">
          <Briefcase className="h-4 w-4 text-indigo-500" />
          Trips
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold">
            {trips.length}
          </span>
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3">
          <EventList
            events={trips}
            childrenOf={childrenOf}
            onEdit={onEditTrip}
            onDelete={(id) => void handleDelete(id)}
            onShareSuccess={handleShareSuccess}
            onToggleTodo={onToggleTodo}
            onConvertKind={onConvertKind}
            onHashtagClick={onHashtagClick}
            showActions
            showWatchButton={false}
            viewMode="compact"
            renderItemFooter={renderChecklist}
          />
        </div>
      )}
      {createForTrip && onCreateChecklist && (
        <ChecklistCreateForm
          events={[createForTrip]}
          defaultEventId={createForTrip.id}
          onCreate={onCreateChecklist}
          onClose={() => setCreateForTrip(null)}
        />
      )}
    </div>
  )
}
