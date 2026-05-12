import { useEffect, useState, useCallback } from 'react'
import { getStory } from '../services/storyService'
import type { StoryWithEventsAndSiblings } from '../types/story'

export function useStory(id: string | undefined) {
  const [story, setStory] = useState<StoryWithEventsAndSiblings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    if (!id) { setStory(null); setLoading(false); return }
    try {
      setLoading(true)
      setStory(await getStory(id))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { refresh() }, [refresh])

  return { story, loading, error, refresh }
}
