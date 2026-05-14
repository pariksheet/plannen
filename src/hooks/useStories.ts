import { useEffect, useState, useCallback } from 'react'
import { dbClient } from '../lib/dbClient'
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
    // Tier 1 wraps Realtime; Tier 0 polls every 30s. Same surface either way.
    const unsubscribe = dbClient.realtime.subscribeToStories(() => { refresh() })
    return unsubscribe
  }, [refresh])

  return { stories, loading, error, refresh }
}
