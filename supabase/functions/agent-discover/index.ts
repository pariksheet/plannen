import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { z } from 'npm:zod@3'
import { generateStructured, aiErrorResponse, AIError } from '../_shared/ai.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const DiscoveryItem = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.string().url(),
  location: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  enrollment_deadline: z.string().nullable().optional(),
})

const DiscoveryResponse = z.object({
  results: z.array(DiscoveryItem),
})

function buildPrompt(query: string): string {
  return `You are an expert event finder. Use the web_search tool to find real upcoming events or activities matching this query: "${query}".

Find 3–5 actual events. For each one return:
- title: event name
- description: brief description (or null)
- url: the official event URL (required, must start with http)
- location: actual place where the event is held (city, region, or "City, Country")
- start_date: YYYY-MM-DD or null
- end_date: YYYY-MM-DD or null
- enrollment_deadline: registration deadline YYYY-MM-DD or null

Rules:
- Real URLs only. One result per domain.
- Prefer events near the place mentioned. If the activity does not exist there, return the nearest relevant options and set "location" to the actual place.
- Sort by relevance — most relevant first.

Return a JSON object: { "results": [ ... ] }.`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { query } = body
    if (!query || typeof query !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_request', message: 'query is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    const parsed = await generateStructured(req, {
      prompt: buildPrompt(query),
      schema: DiscoveryResponse,
      tools: ['web_search'],
    })

    const seenDomains = new Set<string>()
    const deduped = parsed.results.filter((r) => {
      try {
        const host = new URL(r.url).hostname.replace(/^www\./, '')
        if (seenDomains.has(host)) return false
        seenDomains.add(host)
        return true
      } catch {
        return false
      }
    })

    return new Response(
      JSON.stringify({ success: true, results: deduped, query, source: 'claude' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    )
  } catch (err) {
    if (err instanceof AIError) return aiErrorResponse(err, corsHeaders)
    console.error('agent-discover error:', err)
    return new Response(
      JSON.stringify({
        success: false,
        error: 'unknown_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})
