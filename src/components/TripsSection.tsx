import { useState } from 'react'
import { Briefcase, ChevronUp, ChevronDown, Share2, Pencil, Trash2, ListChecks, Plus } from 'lucide-react'
import { format } from 'date-fns'
import type { Event } from '../types/event'
import type { ChecklistRow } from '../lib/dbClient/types'
import { EventList } from './EventList'
import { EventShareModal } from './EventShareModal'
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
  onCreateChecklist?: (input: { title: string; event_id: string | null; items: string[] }) => Promise<void> | void
}

/**
 * The "Trips" section — a collapsible card listing trip containers, each with
 * share / edit / delete and an expandable list of its child events/todos. Shared
 * verbatim between My Plans (MyFeed) and the starred-group Schedule view
 * (ScheduleOverview) so both render the identical UX. Sharing a trip cascades
 * the new audience onto its children.
 */
export function TripsSection({
  trips, childrenOf, onEditTrip, onDeleteEvent, onChange,
  onToggleTodo, onConvertKind, onHashtagClick, defaultOpen = false,
  checklistsOf, onOpenChecklist, onCreateChecklist,
}: TripsSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [shareTrip, setShareTrip] = useState<Event | null>(null)
  const [createForTrip, setCreateForTrip] = useState<Event | null>(null)
  if (trips.length === 0) return null

  const handleDeleteTrip = async (trip: Event) => {
    if (!window.confirm(`Delete the trip "${trip.title}"? Its events and to-dos stay — they're just no longer grouped.`)) return
    const { error } = await deleteContainer(trip.id)
    if (error) return
    onChange()
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
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-4">
          {trips.map((t) => {
            const members = childrenOf(t.id)
            const range = t.end_date
              ? `${format(new Date(t.start_date), 'd MMM')} – ${format(new Date(t.end_date), 'd MMM yyyy')}`
              : format(new Date(t.start_date), 'd MMM yyyy')
            return (
              <div key={t.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{t.title}</p>
                    <p className="text-xs text-gray-500">{range}</p>
                  </div>
                  <div className="flex items-center flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setShareTrip(t)}
                      className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-indigo-600"
                      aria-label={`Share trip ${t.title}`}
                      title="Share this trip"
                    >
                      <Share2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditTrip(t)}
                      className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-indigo-600"
                      aria-label={`Edit trip ${t.title}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteTrip(t)}
                      className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-red-600"
                      aria-label={`Delete trip ${t.title}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {members.length === 0 ? (
                  <p className="text-xs text-gray-500 mt-1">Nothing in this trip yet. Add events or to-dos to it from the create form.</p>
                ) : (
                  <EventList
                    events={members}
                    onEdit={onEditTrip}
                    onDelete={onDeleteEvent}
                    onShareSuccess={onChange}
                    onToggleTodo={onToggleTodo}
                    onConvertKind={onConvertKind}
                    onHashtagClick={onHashtagClick}
                    showActions
                    showWatchButton={false}
                    viewMode="compact"
                  />
                )}
                {(checklistsOf || onCreateChecklist) && (
                  <div className="mt-2 space-y-1">
                    {(checklistsOf?.(t.id) ?? []).map((cl) => {
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
                      <button type="button" onClick={() => setCreateForTrip(t)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 px-1.5 py-1">
                        <Plus className="h-3.5 w-3.5" /> Checklist
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
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
      {shareTrip && (
        <EventShareModal
          event={shareTrip}
          onClose={() => setShareTrip(null)}
          onSuccess={() => {
            const trip = shareTrip
            setShareTrip(null)
            void (async () => {
              // Cascade the trip's new sharing onto its children so the whole
              // trip (band + its events) shows for the same people/groups.
              if (trip) {
                const childIds = childrenOf(trip.id).map((e) => e.id)
                if (childIds.length) await syncTripSharing(trip.id, childIds)
              }
              onChange()
            })()
          }}
        />
      )}
    </div>
  )
}
