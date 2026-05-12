import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { listStories } from '../services/storyService'
import type { StoryWithEvents } from '../types/story'

export function useStories() {
  const [stories, setStories] = useState<StoryWithEvents[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setStories(await listStories())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const channel = supabase
      .channel('stories-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stories' }, () => { refresh() })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [refresh])

  return { stories, loading, error, refresh }
}
