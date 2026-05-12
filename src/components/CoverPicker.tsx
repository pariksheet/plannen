import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabase'

interface MemoryRow {
  id: string
  media_url: string | null
  taken_at: string | null
  created_at: string
}

interface Props {
  eventIds: string[]
  currentUrl: string | null
  onSelect: (url: string) => void
  onClose: () => void
}

export function CoverPicker({ eventIds, currentUrl, onSelect, onClose }: Props) {
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (eventIds.length === 0) { setMemories([]); setLoading(false); return }
    void (async () => {
      const { data, error } = await supabase
        .from('event_memories')
        .select('id, media_url, taken_at, created_at')
        .in('event_id', eventIds)
        .not('media_url', 'is', null)
        .eq('media_type', 'image')
        .order('taken_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
      if (!error) setMemories((data as MemoryRow[] | null) ?? [])
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
          {!loading && memories.length === 0 && (
            <div className="text-gray-500 text-sm">No photos attached to the linked events.</div>
          )}
          <div className="grid grid-cols-3 gap-2">
            {memories.map(m => {
              const selected = m.media_url === currentUrl
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => m.media_url && onSelect(m.media_url)}
                  className={`relative aspect-square rounded overflow-hidden ring-2 ${selected ? 'ring-indigo-500' : 'ring-transparent'} hover:ring-indigo-300`}
                >
                  <img src={m.media_url ?? ''} alt="" className="w-full h-full object-cover" />
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
