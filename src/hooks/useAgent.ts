import { supabase } from '../lib/supabase'
import { useSettings } from '../context/SettingsContext'
import type { ScrapeResponse } from '../types/agent'

export function useAgent() {
  const { hasAiKey } = useSettings()

  const scrapeUrl = async (url: string, eventId?: string) => {
    const { data, error: funcError } = await supabase.functions.invoke('agent-scrape', {
      body: { url, event_id: eventId },
    })
    if (funcError) return { data: null, error: funcError }
    return { data: data as ScrapeResponse | null, error: null }
  }

  const extractFromImage = async (imageUrl: string) => {
    const { data, error: funcError } = await supabase.functions.invoke('agent-extract-image', {
      body: { image_url: imageUrl },
    })
    if (funcError) return { data: null, error: funcError }
    return { data: data as ScrapeResponse | null, error: null }
  }

  return { scrapeUrl, extractFromImage, hasApiKey: hasAiKey }
}
