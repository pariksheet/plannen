import { dbClient } from '../lib/dbClient'
import { useSettings } from '../context/SettingsContext'
import type { ScrapeResponse } from '../types/agent'

export function useAgent() {
  const { hasAiKey } = useSettings()

  const scrapeUrl = async (url: string, eventId?: string) => {
    try {
      const data = await dbClient.functions.invoke<ScrapeResponse>('agent-scrape', { url, event_id: eventId })
      return { data, error: null }
    } catch (e) {
      return { data: null, error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  const extractFromImage = async (imageUrl: string) => {
    try {
      const data = await dbClient.functions.invoke<ScrapeResponse>('agent-extract-image', { image_url: imageUrl })
      return { data, error: null }
    } catch (e) {
      return { data: null, error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  return { scrapeUrl, extractFromImage, hasApiKey: hasAiKey }
}
