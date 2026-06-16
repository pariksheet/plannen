import { useState } from 'react'
import { Briefcase, ChevronUp, ChevronDown, ListChecks, Plus, Share2, Pencil, Trash2, Check, X } from 'lucide-react'
import type { Event } from '../types/event'
import type { ChecklistRow } from '../lib/dbClient/types'
import { renameChecklist, deleteChecklist, type NewChecklistItem } from '../services/checklistService'
import { EventList } from './EventList'
import { ChecklistCreateForm } from './ChecklistCreateForm'
import { ChecklistShareModal } from './ChecklistShareModal'
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
  /** Reload the checklist data after a rename/delete/share. Defaults to onChange. */
  onChecklistsChange?: () => void
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
  checklistsOf, onOpenChecklist, onCreateChecklist, onChecklistsChange,
}: TripsSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [createForTrip, setCreateForTrip] = useState<Event | null>(null)
  const [shareChecklistRow, setShareChecklistRow] = useState<ChecklistRow | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  if (trips.length === 0) return null

  const tripIds = new Set(trips.map((t) => t.id))
  const reloadChecklists = onChecklistsChange ?? onChange

  const saveRename = async () => {
    const id = renameId, title = renameText.trim()
    setRenameId(null)
    if (id && title) { await renameChecklist(id, title); reloadChecklists() }
  }
  const handleDeleteChecklist = async (cl: ChecklistRow) => {
    if (!window.confirm(`Delete the checklist "${cl.title}"? This can't be undone.`)) return
    await deleteChecklist(cl.id)
    reloadChecklists()
  }

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
          if (renameId === cl.id) {
            return (
              <div key={cl.id} className="flex items-center gap-1 text-xs">
                <input
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setRenameId(null) }}
                  className="flex-1 min-w-0 border border-gray-200 rounded px-1.5 py-1 text-xs"
                />
                <button type="button" onClick={() => void saveRename()} aria-label="Save name" className="p-1.5 text-gray-400 hover:text-green-600"><Check className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => setRenameId(null)} aria-label="Cancel rename" className="p-1.5 text-gray-400 hover:text-gray-700"><X className="h-3.5 w-3.5" /></button>
              </div>
            )
          }
          const inner = (
            <>
              <ListChecks className="h-3.5 w-3.5 text-indigo-500 shrink-0" aria-hidden />
              <span className="truncate">{cl.title}</span>
              <span className="ml-auto text-gray-400 tabular-nums">{done}/{total}</span>
            </>
          )
          return (
            <div key={cl.id} className="flex items-center gap-1 text-xs">
              {onOpenChecklist ? (
                <button type="button" onClick={() => onOpenChecklist(cl.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left text-gray-700 rounded px-1.5 py-1 hover:bg-gray-50">{inner}</button>
              ) : (
                <div className="flex items-center gap-2 flex-1 min-w-0 text-gray-600 px-1.5 py-1">{inner}</div>
              )}
              <div className="flex items-center flex-shrink-0">
                <button type="button" onClick={() => setShareChecklistRow(cl)} aria-label={`Share checklist ${cl.title}`} title="Share" className="p-1.5 text-gray-400 hover:text-indigo-600"><Share2 className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => { setRenameId(cl.id); setRenameText(cl.title) }} aria-label={`Rename checklist ${cl.title}`} title="Rename" className="p-1.5 text-gray-400 hover:text-indigo-600"><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => void handleDeleteChecklist(cl)} aria-label={`Delete checklist ${cl.title}`} title="Delete" className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
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
      {shareChecklistRow && (
        <ChecklistShareModal
          checklistId={shareChecklistRow.id}
          title={shareChecklistRow.title}
          onClose={() => setShareChecklistRow(null)}
          onShared={reloadChecklists}
        />
      )}
    </div>
  )
}
