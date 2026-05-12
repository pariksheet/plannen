import { useState, useEffect } from 'react'
import { Music } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getMemoryImageProxyUrl } from '../services/memoryService'
import type { EventMemory, MemorySource } from '../services/memoryService'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''

interface MemoryImageProps {
  memory: EventMemory
  className?: string
  alt?: string
  lightbox?: boolean
}

export function MemoryImage({ memory, className, alt = '', lightbox = false }: MemoryImageProps) {
  const [proxyUrl, setProxyUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const source = (memory.source ?? 'upload') as MemorySource
  const isProxy = source === 'google_drive' || source === 'google_photos'

  useEffect(() => {
    if (!isProxy || !supabaseUrl) return
    let cancelled = false
    let objectUrl: string | null = null
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || cancelled) return
      const url = getMemoryImageProxyUrl(memory.id, supabaseUrl)
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (cancelled) return
        if (!res.ok) {
          setError(true)
          return
        }
        const blob = await res.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setProxyUrl(objectUrl)
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [memory.id, isProxy])

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
    return <img src={memory.media_url} alt={alt} className={className} />
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
    return <img src={proxyUrl} alt={alt} className={className} />
  }
  if (error || (isProxy && !proxyUrl)) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-gray-500 text-xs ${className ?? ''}`}>
        Media unavailable
      </div>
    )
  }
  if (isProxy) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-gray-400 text-xs animate-pulse ${className ?? ''}`}>
        Loading…
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
