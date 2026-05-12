import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { useStories } from '../hooks/useStories'
import { getStoryLanguages } from '../services/profileService'
import { formatStorySubtitle } from '../utils/storySubtitle'
import type { StoryWithEvents } from '../types/story'

function dedupeByGroup(stories: StoryWithEvents[], preferredLangs: string[]): StoryWithEvents[] {
  const priority = new Map(preferredLangs.map((c, i) => [c, i]))
  const fallback = preferredLangs.length
  const score = (lang: string) => priority.get(lang) ?? fallback
  const picked = new Map<string, StoryWithEvents>()
  const order: string[] = []
  for (const s of stories) {
    const existing = picked.get(s.story_group_id)
    if (!existing) {
      picked.set(s.story_group_id, s)
      order.push(s.story_group_id)
    } else if (score(s.language) < score(existing.language)) {
      picked.set(s.story_group_id, s)
    }
  }
  return order.map(id => picked.get(id)!)
}

const PLACEHOLDER_GRADIENT = 'bg-gradient-to-br from-indigo-300 via-purple-300 to-pink-300'

function Cover({ url, className }: { url: string | null; className: string }) {
  const [errored, setErrored] = useState(false)
  if (!url || errored) {
    return <div className={`${className} ${PLACEHOLDER_GRADIENT}`} aria-hidden="true" />
  }
  return (
    <img
      src={url}
      alt=""
      className={`${className} object-cover`}
      onError={() => setErrored(true)}
    />
  )
}

function HeroCard({ story }: { story: StoryWithEvents }) {
  const subtitle = formatStorySubtitle(story)
  const opener = story.body.slice(0, 140) + (story.body.length > 140 ? '…' : '')
  return (
    <Link
      to={`/stories/${story.id}`}
      className="block bg-white rounded-xl shadow-sm hover:shadow-md transition overflow-hidden mb-6"
    >
      <div className="relative">
        <Cover url={story.cover_url} className="w-full aspect-[21/9]" />
      </div>
      <div className="p-5">
        <div className="text-xs uppercase tracking-wide text-gray-500">{subtitle}</div>
        <h3 className="text-xl font-semibold text-gray-900 mt-1">{story.title}</h3>
        <p className="text-sm text-gray-600 mt-2 leading-relaxed">{opener}</p>
      </div>
    </Link>
  )
}

function GridCard({ story }: { story: StoryWithEvents }) {
  const subtitle = formatStorySubtitle(story)
  return (
    <Link
      to={`/stories/${story.id}`}
      className="block bg-white rounded-lg shadow-sm hover:shadow-md transition overflow-hidden"
    >
      <div className="relative">
        <Cover url={story.cover_url} className="w-full aspect-square" />
      </div>
      <div className="p-3">
        <div className="text-xs text-gray-500 truncate">{subtitle}</div>
        <h4 className="text-sm font-semibold text-gray-900 mt-1 line-clamp-2">{story.title}</h4>
      </div>
    </Link>
  )
}

export function MyStories() {
  const { stories, loading, error } = useStories()
  const [preferredLangs, setPreferredLangs] = useState<string[]>(['en'])

  useEffect(() => {
    void getStoryLanguages().then(({ data }) => setPreferredLangs(data))
  }, [])

  if (loading) return <div className="text-gray-500 py-12 text-center">Loading…</div>
  if (error) return <div className="text-red-600 py-12 text-center">Couldn't load stories: {error.message}</div>
  if (stories.length === 0) {
    return (
      <div className="py-16 text-center text-gray-500">
        <BookOpen className="mx-auto h-10 w-10 text-gray-300" />
        <p className="mt-3 text-sm">No stories yet. Ask the agent to write one for any past event.</p>
      </div>
    )
  }

  const grouped = dedupeByGroup(stories, preferredLangs)
  const [hero, ...rest] = grouped
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-4">My Stories</h2>
      <HeroCard story={hero} />
      {rest.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {rest.map(s => <GridCard key={s.id} story={s} />)}
        </div>
      )}
    </div>
  )
}
