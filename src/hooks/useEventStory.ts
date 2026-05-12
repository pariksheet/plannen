import { useEffect, useState, useCallback } from 'react'
import { getEventStory } from '../services/storyService'
import type { StoryWithEvents } from '../types/story'

export function useEventStory(eventId: string | undefined) {
  const [story, setStory] = useState<StoryWithEvents | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!eventId) { setStory(null); setLoading(false); return }
    try {
      setLoading(true)
      setStory(await getEventStory(eventId))
    } catch (e) {
      console.error('useEventStory error', e)
      setStory(null)
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { refresh() }, [refresh])

  return { story, loading, refresh }
}
