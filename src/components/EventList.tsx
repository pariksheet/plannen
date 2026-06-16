import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Event, EventViewMode } from '../types/event'
import { EventCard } from './EventCard'

interface EventListProps {
  events: Event[]
  onEdit?: (event: Event) => void
  onClone?: (event: Event) => void
  onDelete?: (eventId: string) => void
  onShareSuccess?: (event: Event) => void
  onHashtagClick?: (tag: string) => void
  onToggleTodo?: (event: Event) => void
  onConvertKind?: (event: Event, kind: 'reminder' | 'todo') => void
  showActions?: boolean
  showRSVP?: boolean
  showMemories?: boolean
  showWatchButton?: boolean
  viewMode?: EventViewMode
  emptyMessage?: string
  /** Resolve a container's child events/todos. When given, each trip card gets
   *  an "Events (N)" toggle that expands its children inline (as compact cards),
   *  so a trip looks like any other event card everywhere it appears. */
  childrenOf?: (tripId: string) => Event[]
  /** Render extra content beneath each top-level card (e.g. a trip's checklist).
   *  Not threaded into expanded children — top level only. */
  renderItemFooter?: (event: Event) => ReactNode
}

export function EventList({
  events,
  onEdit,
  onClone,
  onDelete,
  onShareSuccess,
  onHashtagClick,
  onToggleTodo,
  onConvertKind,
  showActions = false,
  showRSVP = false,
  showMemories = false,
  showWatchButton = false,
  viewMode = 'compact',
  emptyMessage = 'No events found',
  childrenOf,
  renderItemFooter,
}: EventListProps) {
  const [openTrips, setOpenTrips] = useState<Record<string, boolean>>({})
  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    )
  }
  return (
    <div className="w-full max-w-2xl mx-auto space-y-6 min-w-0">
      {events.map((event) => {
        const kids = event.event_kind === 'container' && childrenOf ? childrenOf(event.id) : null
        const card = (
          <EventCard
            event={event}
            onEdit={onEdit}
            onClone={onClone}
            onDelete={onDelete}
            onShareSuccess={onShareSuccess}
            onHashtagClick={onHashtagClick}
            onToggleTodo={onToggleTodo}
            onConvertKind={onConvertKind}
            showActions={showActions}
            showRSVP={showRSVP}
            showMemories={showMemories}
            showWatchButton={showWatchButton}
            viewMode={viewMode}
          />
        )
        const footer = renderItemFooter?.(event)
        if (!kids) return <div key={event.id}>{card}{footer}</div>
        const isOpen = !!openTrips[event.id]
        return (
          <div key={event.id}>
            {card}
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setOpenTrips((m) => ({ ...m, [event.id]: !m[event.id] }))}
                aria-expanded={isOpen}
                className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 px-1.5 py-1"
              >
                Events ({kids.length})
                {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {isOpen && (
                kids.length > 0 ? (
                  <div className="mt-1 border-l-2 border-violet-100 pl-2">
                    <EventList
                      events={kids}
                      onEdit={onEdit}
                      onClone={onClone}
                      onDelete={onDelete}
                      onShareSuccess={onShareSuccess}
                      onHashtagClick={onHashtagClick}
                      onToggleTodo={onToggleTodo}
                      onConvertKind={onConvertKind}
                      showActions={showActions}
                      viewMode="compact"
                    />
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 px-1.5 py-1">Nothing in this trip yet.</p>
                )
              )}
            </div>
            {footer}
          </div>
        )
      })}
    </div>
  )
}
