import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface MemoryRow {
  id: string
  media_url: string | null
  media_type: string | null
  caption: string | null
  taken_at: string | null
  created_at: string
}

export interface StripPhoto {
  url: string
  caption: string | null
}

interface Props {
  eventIds: string[]
  coverUrl: string | null
  selectedUrl: string | null
  onSelect: (photo: StripPhoto | null) => void
}

export function StoryPhotoStrip({ eventIds, coverUrl, selectedUrl, onSelect }: Props) {
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (eventIds.length === 0) { setMemories([]); setLoading(false); return }
    void (async () => {
      const { data, error } = await supabase
        .from('event_memories')
        .select('id, media_url, media_type, caption, taken_at, created_at')
        .in('event_id', eventIds)
        .not('media_url', 'is', null)
        .eq('media_type', 'image')
        .order('taken_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
      if (!error) setMemories((data as MemoryRow[] | null) ?? [])
      setLoading(false)
    })()
  }, [eventIds])

  const items: { key: string; url: string; caption: string | null; isCover: boolean }[] = []
  const seen = new Set<string>()
  if (coverUrl) {
    items.push({ key: 'cover', url: coverUrl, caption: null, isCover: true })
    seen.add(coverUrl)
  }
  for (const m of memories) {
    if (!m.media_url || seen.has(m.media_url)) continue
    items.push({ key: m.id, url: m.media_url, caption: m.caption, isCover: false })
    seen.add(m.media_url)
  }

  if (loading || items.length === 0) return null

  return (
    <div className="-mx-4 px-4 overflow-x-auto">
      <div className="flex gap-2 py-2">
        {items.map((it) => {
          const isActive = it.url === selectedUrl
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => onSelect(isActive ? null : { url: it.url, caption: it.caption })}
              className={`relative flex-shrink-0 w-16 h-16 rounded overflow-hidden ring-2 transition-shadow ${
                isActive ? 'ring-indigo-500' : 'ring-gray-200 hover:ring-indigo-400'
              } focus:outline-none focus:ring-indigo-500`}
              aria-label={isActive ? 'Reset cover' : 'Show this image in cover'}
              aria-pressed={isActive}
              title={it.isCover ? 'Cover' : undefined}
            >
              <img src={it.url} alt="" className="w-full h-full object-cover" loading="lazy" />
              {it.isCover && (
                <span className="absolute bottom-0 inset-x-0 text-[9px] font-medium uppercase tracking-wide text-white bg-black/55 text-center py-0.5">
                  Cover
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
