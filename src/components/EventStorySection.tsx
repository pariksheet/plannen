import { Link } from 'react-router-dom'
import { BookOpen, Pencil } from 'lucide-react'
import { useEventStory } from '../hooks/useEventStory'
import { formatStorySubtitle } from '../utils/storySubtitle'

interface Props {
  eventId: string
}

export function EventStorySection({ eventId }: Props) {
  const { story, loading } = useEventStory(eventId)
  if (loading) return null

  if (!story) {
    return (
      <div className="mt-4 px-4 py-3 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-500 flex items-center gap-2">
        <BookOpen className="h-4 w-4" />
        <span>No story yet. Ask the agent to write one for this event.</span>
      </div>
    )
  }

  const opener = story.body.slice(0, 180) + (story.body.length > 180 ? '…' : '')
  const isMultiEvent = story.events.length > 1
  const partOf = isMultiEvent ? `Part of '${formatStorySubtitle(story)}'` : null

  return (
    <div className="mt-4 px-4 py-3 rounded-lg bg-purple-50 border border-purple-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-purple-700 inline-flex items-center gap-1">
            <BookOpen className="h-3 w-3" /> Story{partOf ? ` · ${partOf}` : ''}
          </div>
          <div className="font-semibold text-gray-900 mt-1">{story.title}</div>
          <p className="text-sm text-gray-700 mt-1 leading-relaxed">{opener}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 text-sm">
        <Link to={`/stories/${story.id}`} className="text-indigo-600 hover:underline">Read full</Link>
        <Link to={`/stories/${story.id}?edit=1`} className="text-gray-600 hover:underline inline-flex items-center gap-1"><Pencil className="h-3 w-3" /> Edit</Link>
      </div>
    </div>
  )
}
