import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Event, EventViewMode } from '../types/event'
import { EventCard } from './EventCard'
import { TimelineItem, groupTimelineByMonth } from '../utils/timeline'

interface TimelineProps {
  items: TimelineItem[]
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

export function Timeline({
  items,
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
  emptyMessage = 'No upcoming events',
}: TimelineProps) {
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set())

  const toggleMonth = (monthKey: string) => {
    setCollapsedMonths(prev => {
      const next = new Set(prev)
      next.has(monthKey) ? next.delete(monthKey) : next.add(monthKey)
      return next
    })
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    )
  }

  const groups = groupTimelineByMonth(items)

  return (
    <div className="w-full max-w-2xl mx-auto min-w-0">
      {groups.map(({ monthKey, label, items: groupItems }) => (
        <section key={monthKey} className="mb-8">
          <button
            type="button"
            onClick={() => toggleMonth(monthKey)}
            className="w-full flex items-center justify-between text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3 py-1 -mx-1 px-1 sticky top-0 bg-gray-50 sm:bg-transparent hover:text-gray-700"
          >
            <span>{label} ({groupItems.length})</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsedMonths.has(monthKey) ? '-rotate-90' : ''}`} />
          </button>
          {!collapsedMonths.has(monthKey) && (
            <div className="space-y-4">
              {(() => {
                const hasPastToday = groupItems.some((i) => i.isPastToday)
                let nowInserted = false
                return groupItems.flatMap((item) => {
                  const els = []
                  if (hasPastToday && !nowInserted && !item.isPastToday) {
                    nowInserted = true
                    els.push(
                      <div key="now-divider" className="flex items-center gap-2 py-1">
                        <div className="flex-1 h-px bg-blue-300" />
                        <span className="text-xs text-blue-500 font-medium tracking-wide">now</span>
                        <div className="flex-1 h-px bg-blue-300" />
                      </div>
                    )
                  }
                  els.push(
                    <EventCard
                      key={item.event.id}
                      event={item.event}
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
                      isImmediateNext={item.isImmediateNext}
                      nextExpectedDate={item.nextExpectedDate?.toISOString()}
                      dimmed={item.isPastToday}
                    />
                  )
                  return els
                })
              })()}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
