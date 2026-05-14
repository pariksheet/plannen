import { useState, useImperativeHandle, forwardRef } from 'react'
import { dbClient } from '../lib/dbClient'
import { useAgent } from '../hooks/useAgent'
import { useSettings } from '../context/SettingsContext'
import { DiscoveryResult, ScrapeResponse } from '../types/agent'
import { EventFormData } from '../types/event'
import { Send, Loader, MapPin } from 'lucide-react'

export interface AgentChatHandle {
  resetDiscovery: () => void
}

interface AgentChatProps {
  onEventCreated?: () => void
  onStartCreateWithData?: (data: EventFormData) => void
}

export const AgentChat = forwardRef<AgentChatHandle, AgentChatProps>(function AgentChat(
  { onEventCreated, onStartCreateWithData },
  ref
) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<DiscoveryResult[]>([])
  const { scrapeUrl } = useAgent()
  const { hasAiKey } = useSettings()

  const resetDiscovery = () => {
    setQuery('')
    setResults([])
    setError('')
  }

  useImperativeHandle(ref, () => ({
    resetDiscovery,
  }))

  const handleDiscover = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    if (!hasAiKey) {
      setError('No AI provider configured. Open AI Settings (the "AI" button in the nav bar) and paste your Anthropic key.')
      return
    }
    setLoading(true)
    setError('')
    setResults([])
    try {
      let data: { results?: unknown; error?: string; message?: string } | null = null
      try {
        data = await dbClient.functions.invoke<{ results?: unknown; error?: string; message?: string }>(
          'agent-discover',
          { query: query.trim() },
        )
      } catch (e) {
        setError((e as Error).message || 'Failed to call discovery function')
        return
      }
      if (!data) {
        setError('No response from discovery function')
        return
      }
      if (data.error) {
        setError(data.message || data.error)
        return
      }
      const list = Array.isArray(data.results) ? (data.results as DiscoveryResult[]) : []

      const normalize = (items: DiscoveryResult[]): DiscoveryResult[] => {
        const socialHosts = ['facebook.com', 'm.facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'linkedin.com', 'youtube.com', 'youtu.be']
        const getHost = (url: string): string | null => {
          try {
            const u = new URL(url)
            return u.hostname.replace(/^www\./, '')
          } catch {
            return null
          }
        }
        const nonSocial: DiscoveryResult[] = []
        const social: DiscoveryResult[] = []
        const seen = new Set<string>()
        for (const item of items) {
          if (!item?.url) continue
          const host = getHost(item.url)
          if (!host || seen.has(host)) continue
          seen.add(host)
          const isSocial = socialHosts.some((s) => host === s || host.endsWith(`.${s}`))
          if (isSocial) social.push(item)
          else nonSocial.push(item)
        }
        if (nonSocial.length > 0) {
          return nonSocial.slice(0, 5)
        }
        return social.slice(0, 5)
      }

      setResults(normalize(list))
      if (list.length === 0) {
        setError('No events found. Try different keywords or add a URL manually.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover events')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectResult = async (result: DiscoveryResult) => {
    setLoading(true)
    setError('')
    try {
      let scrapeData: ScrapeResponse | null = null
      if (result.url) {
        const res = await scrapeUrl(result.url) as { data: ScrapeResponse | null }
        scrapeData = res.data ?? null
      }
      const startDateStr = scrapeData?.extracted?.start_date || result.start_date
      const endDateStr = (scrapeData?.extracted?.end_date || result.end_date) ?? null
      let startDate: string
      try {
        const parsed = startDateStr ? new Date(startDateStr) : null
        startDate = parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
      } catch {
        startDate = new Date().toISOString()
      }
      let endDate = ''
      try {
        if (endDateStr) {
          const parsedEnd = new Date(endDateStr)
          if (!isNaN(parsedEnd.getTime())) endDate = parsedEnd.toISOString()
        }
      } catch {
        endDate = ''
      }

      const eventData: EventFormData = {
        title: scrapeData?.extracted?.title || result.title,
        description: scrapeData?.extracted?.description || result.description || '',
        start_date: startDate,
        end_date: endDate,
        enrollment_url: result.url,
        enrollment_deadline: scrapeData?.extracted?.enrollment_deadline || result.enrollment_deadline || '',
        enrollment_start_date: '',
        image_url: scrapeData?.extracted?.image_url ?? result.image_url ?? '',
        location: scrapeData?.extracted?.location ?? result.location ?? '',
        hashtags: [],
        event_kind: 'event',
        event_type: 'personal',
        shared_with_family: false,
        shared_with_friends: 'none',
        shared_with_user_ids: [],
        shared_with_group_ids: [],
      }

      if (onStartCreateWithData) {
        onStartCreateWithData(eventData)
      } else {
        // Fallback: just clear results; caller can handle creating separately if needed
        onEventCreated?.()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create event')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 w-full min-w-0">
      <form onSubmit={handleDiscover} className="mb-4">
        <div className="flex gap-2 min-w-0 flex-wrap sm:flex-nowrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g., summer camps for 5 year old"
            className="flex-1 min-w-0 px-3 py-2 min-h-[44px] border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="min-h-[44px] px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            Discover
          </button>
          {(query.trim() || results.length > 0 || error) && (
            <button
              type="button"
              onClick={resetDiscovery}
              className="min-h-[44px] px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
            >
              Reset
            </button>
          )}
        </div>
      </form>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-800 font-medium mb-1">Error</p>
          <p className="text-sm text-red-700 whitespace-pre-line font-sans mb-2">{error}</p>
          <p className="text-xs text-red-600">
            <strong>Quick checks:</strong> backend running (<code>bash scripts/backend-start.sh</code>), AI provider configured (<code>/settings</code>), browser console (F12), TROUBLESHOOTING.md.
          </p>
        </div>
      )}
      {results.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-700">
            Found {results.length} {results.length === 1 ? 'option' : 'options'} (click link to preview, or card to add):
          </p>
          {results.map((result, index) => (
            <div
              key={index}
              className="border border-gray-200 rounded-md p-4 hover:border-indigo-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between mb-2">
                <h4 className="font-semibold text-gray-900 flex-1 text-lg sm:text-xl">{result.title}</h4>
                {result.url && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="ml-3 text-xs text-indigo-600 hover:underline flex items-center"
                  >
                    Preview ↗
                  </a>
                )}
              </div>
              {result.description && (
                <p className="text-sm text-gray-600 mt-1 mb-2">{result.description}</p>
              )}
              <div className="mt-2 text-xs text-gray-500 space-y-1">
                {result.url && (
                  <p className="break-all">
                    <span className="font-medium">URL:</span>{' '}
                    <a href={result.url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">
                      {result.url}
                    </a>
                  </p>
                )}
                {result.start_date && (
                  <p><span className="font-medium">Start:</span> {new Date(result.start_date).toLocaleDateString()}</p>
                )}
                {result.location && (
                  <p className="flex items-center gap-1">
                    <span className="font-medium">Location:</span>
                    <span>{result.location}</span>
                    <a
                      href={`https://www.google.com/maps/search/?q=${encodeURIComponent(result.location)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center text-indigo-600 hover:text-indigo-800"
                    >
                      <MapPin className="h-3 w-3" />
                    </a>
                  </p>
                )}
                {result.enrollment_deadline && (
                  <p><span className="font-medium">Registration deadline:</span> {new Date(result.enrollment_deadline).toLocaleDateString()}</p>
                )}
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => handleSelectResult(result)}
                  className="flex-1 min-h-[44px] py-3 px-4 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 flex items-center justify-center"
                >
                  Add This Event
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
