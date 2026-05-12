import { Event, EventViewMode } from '../types/event'
import { EventCard } from './EventCard'

interface EventListProps {
  events: Event[]
  onEdit?: (event: Event) => void
  onClone?: (event: Event) => void
  onDelete?: (eventId: string) => void
  onShareSuccess?: () => void
  onHashtagClick?: (tag: string) => void
  showActions?: boolean
  showRSVP?: boolean
  showMemories?: boolean
  showWatchButton?: boolean
  viewMode?: EventViewMode
  emptyMessage?: string
}

export function EventList({
  events,
  onEdit,
  onClone,
  onDelete,
  onShareSuccess,
  onHashtagClick,
  showActions = false,
  showRSVP = false,
  showMemories = false,
  showWatchButton = false,
  viewMode = 'compact',
  emptyMessage = 'No events found',
}: EventListProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    )
  }
  return (
    <div className="w-full max-w-2xl mx-auto space-y-6 min-w-0">
      {events.map((event) => (
        <EventCard
          key={event.id}
          event={event}
          onEdit={onEdit}
          onClone={onClone}
          onDelete={onDelete}
          onShareSuccess={onShareSuccess}
          onHashtagClick={onHashtagClick}
          showActions={showActions}
          showRSVP={showRSVP}
          showMemories={showMemories}
          showWatchButton={showWatchButton}
          viewMode={viewMode}
        />
      ))}
    </div>
  )
}
