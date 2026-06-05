import { useEffect, useState } from 'react'
import { dbClient } from '../lib/dbClient'
import { getMemoryImageProxyUrl } from '../services/memoryService'
import { TIER } from '../lib/tier'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''

interface MemoryRow {
  id: string
  media_url: string | null
  media_type: string | null
  source: string | null
  caption: string | null
  taken_at: string | null
  created_at: string
}

export interface StripPhoto {
  url: string
  caption: string | null
}

interface DisplayItem {
  id: string
  url: string
  caption: string | null
  taken_at: string | null
  created_at: string
}

interface Props {
  eventIds: string[]
  coverUrl: string | null
  selectedUrl: string | null
  onSelect: (photo: StripPhoto | null) => void
}

function toDisplayUrl(memory: MemoryRow): string | null {
  if (memory.media_url) return memory.media_url
  if (memory.source === 'google_photos' || memory.source === 'google_drive') {
    return getMemoryImageProxyUrl(memory.id, TIER === '0' ? '' : supabaseUrl)
  }
  return null
}

export function StoryPhotoStrip({ eventIds, coverUrl, selectedUrl, onSelect }: Props) {
  const [memories, setMemories] = useState<DisplayItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (eventIds.length === 0) { setMemories([]); setLoading(false); return }
    void (async () => {
      let rows: MemoryRow[] = []
      try {
        const all = await dbClient.memories.list({ event_ids: eventIds, limit: 200 }) as MemoryRow[]
        rows = all.filter((m) => m.media_type === 'image')
      } catch {
        rows = []
      }
      const display = rows
        .map((m) => {
          const url = toDisplayUrl(m)
          if (!url) return null
          return { id: m.id, url, caption: m.caption, taken_at: m.taken_at, created_at: m.created_at }
        })
        .filter((m): m is DisplayItem => m !== null)
        .sort((a, b) => {
          const at = (a.taken_at ?? '') || a.created_at
          const bt = (b.taken_at ?? '') || b.created_at
          return at.localeCompare(bt)
        })
      setMemories(display)
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
    if (seen.has(m.url)) continue
    items.push({ key: m.id, url: m.url, caption: m.caption, isCover: false })
    seen.add(m.url)
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
