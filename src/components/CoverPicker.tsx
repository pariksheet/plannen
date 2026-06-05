import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { dbClient } from '../lib/dbClient'
import { getMemoryImageProxyUrl } from '../services/memoryService'
import { TIER } from '../lib/tier'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''

interface MemoryRow {
  id: string
  media_url: string | null
  media_type: string | null
  source: string | null
  taken_at: string | null
  created_at: string
}

interface DisplayItem {
  id: string
  url: string
  taken_at: string | null
  created_at: string
}

interface Props {
  eventIds: string[]
  currentUrl: string | null
  onSelect: (url: string) => void
  onClose: () => void
}

function toDisplayUrl(memory: MemoryRow): string | null {
  if (memory.media_url) return memory.media_url
  if (memory.source === 'google_photos' || memory.source === 'google_drive') {
    return getMemoryImageProxyUrl(memory.id, TIER === '0' ? '' : supabaseUrl)
  }
  return null
}

export function CoverPicker({ eventIds, currentUrl, onSelect, onClose }: Props) {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (eventIds.length === 0) { setItems([]); setLoading(false); return }
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
          return { id: m.id, url, taken_at: m.taken_at, created_at: m.created_at }
        })
        .filter((m): m is DisplayItem => m !== null)
        .sort((a, b) => {
          const at = (a.taken_at ?? '') || a.created_at
          const bt = (b.taken_at ?? '') || b.created_at
          return at.localeCompare(bt)
        })
      setItems(display)
      setLoading(false)
    })()
  }, [eventIds])

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold">Choose a cover</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4">
          {loading && <div className="text-gray-500 text-sm">Loading…</div>}
          {!loading && items.length === 0 && (
            <div className="text-gray-500 text-sm">No photos attached to the linked events.</div>
          )}
          <div className="grid grid-cols-3 gap-2">
            {items.map(m => {
              const selected = m.url === currentUrl
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onSelect(m.url)}
                  className={`relative aspect-square rounded overflow-hidden ring-2 ${selected ? 'ring-indigo-500' : 'ring-transparent'} hover:ring-indigo-300`}
                >
                  <img src={m.url} alt="" className="w-full h-full object-cover" />
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
