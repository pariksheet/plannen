import { useState, useEffect, useRef } from 'react'
import { Music } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getMemoryImageProxyUrl } from '../services/memoryService'
import type { EventMemory, MemorySource } from '../services/memoryService'
import { TIER } from '../lib/tier'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''

// Shared cache: one fetch per memory id across all MemoryImage instances.
// Each consumer creates its own URL.createObjectURL from the awaited blob and
// revokes on unmount; the underlying Blob stays cached for re-mounts.
const blobCache = new Map<string, Promise<Blob>>()

async function fetchMemoryBlob(memoryId: string): Promise<Blob> {
  const existing = blobCache.get(memoryId)
  if (existing) return existing
  const promise = (async () => {
    let url: string
    let headers: HeadersInit = {}
    if (TIER === '0') {
      url = `/functions/v1/memory-image?memory_id=${encodeURIComponent(memoryId)}`
    } else {
      if (!supabaseUrl) throw new Error('No VITE_SUPABASE_URL')
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('No supabase session')
      url = getMemoryImageProxyUrl(memoryId, supabaseUrl)
      headers = { Authorization: `Bearer ${session.access_token}` }
    }
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Proxy ${res.status}`)
    return res.blob()
  })()
  blobCache.set(memoryId, promise)
  // Evict cache entry on failure so retries are possible.
  promise.catch(() => blobCache.delete(memoryId))
  return promise
}

interface MemoryImageProps {
  memory: EventMemory
  className?: string
  alt?: string
  lightbox?: boolean
}

export function MemoryImage({ memory, className, alt = '', lightbox = false }: MemoryImageProps) {
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  // Lightbox mode loads eagerly (user actively requested the larger view);
  // grid mode defers until the tile scrolls into view via IntersectionObserver.
  const [visible, setVisible] = useState(lightbox)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const source = (memory.source ?? 'upload') as MemorySource
  const isProxy = source === 'google_drive' || source === 'google_photos'

  useEffect(() => {
    if (lightbox || !isProxy) return
    const el = containerRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setVisible(true)
          io.disconnect()
          break
        }
      }
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [lightbox, isProxy])

  useEffect(() => {
    if (!isProxy || !visible) return
    let cancelled = false
    let objectUrl: string | null = null
    fetchMemoryBlob(memory.id)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setProxyUrl(objectUrl)
      })
      .catch(() => { if (!cancelled) setError(true) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [memory.id, isProxy, visible])

  if (source === 'upload' && memory.media_url) {
    if (memory.media_type === 'video') {
      return (
        <video
          src={memory.media_url}
          controls
          {...(lightbox ? { autoPlay: true } : { preload: 'metadata' })}
          className={lightbox ? 'max-h-[80vh] max-w-full object-contain rounded' : className}
        />
      )
    }
    if (memory.media_type === 'audio') {
      return <AudioTile memory={memory} url={memory.media_url} className={className} lightbox={lightbox} />
    }
    return <img src={memory.media_url} alt={alt || memory.caption || ''} loading="lazy" className={className} />
  }
  if (isProxy && proxyUrl) {
    if (memory.media_type === 'video') {
      return (
        <video
          src={proxyUrl}
          controls
          {...(lightbox ? { autoPlay: true } : { preload: 'metadata' })}
          className={lightbox ? 'max-h-[80vh] max-w-full object-contain rounded' : className}
        />
      )
    }
    if (memory.media_type === 'audio') {
      return <AudioTile memory={memory} url={proxyUrl} className={className} lightbox={lightbox} />
    }
    return <img src={proxyUrl} alt={alt || memory.caption || ''} loading="lazy" className={className} />
  }
  if (error) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-gray-500 text-xs ${className ?? ''}`}>
        Media unavailable
      </div>
    )
  }
  if (isProxy) {
    return (
      <div
        ref={containerRef}
        className={`flex items-center justify-center bg-gray-100 text-gray-400 text-xs ${visible ? 'animate-pulse' : ''} ${className ?? ''}`}
      >
        {visible ? 'Loading…' : ''}
      </div>
    )
  }
  return (
    <div className={`flex items-center justify-center bg-gray-100 text-gray-500 text-xs ${className ?? ''}`}>
      No media
    </div>
  )
}

function AudioTile({
  memory,
  url,
  className,
  lightbox = false,
}: {
  memory: EventMemory
  url: string
  className?: string
  lightbox?: boolean
}) {
  if (lightbox) {
    return (
      <div className="flex flex-col items-center gap-4 text-white">
        <Music className="w-24 h-24 text-gray-400" />
        {memory.caption && <p className="text-sm">{memory.caption}</p>}
        <audio src={url} controls autoPlay className="w-96 max-w-full" />
      </div>
    )
  }
  return (
    <div className={`flex flex-col items-stretch bg-gray-100 ${className ?? ''}`}>
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <Music className="w-8 h-8" />
      </div>
      <audio src={url} controls className="w-full" />
    </div>
  )
}
