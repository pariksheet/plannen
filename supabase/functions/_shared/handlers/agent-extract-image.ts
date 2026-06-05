// Extract event info from an image (poster/flyer/screenshot). Fetches the
// image URL, sends bytes + prompt to the AI provider, parses the resulting
// JSON loosely (the AI sometimes wraps it in code fences) and normalises
// dates/times into ISO strings.

import { generateFromImage, aiErrorResponse, AIError } from '../ai.ts'
import type { HandlerCtx } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const LOG_PREFIX = '[agent-extract-image]'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

function log(event: string, data?: Record<string, unknown>) {
  const payload = data ? ` ${JSON.stringify(data)}` : ''
  console.log(`${LOG_PREFIX} ${event}${payload}`)
}

const EXTRACT_PROMPT = `You are an expert at extracting event information from images such as flyers, posters, tickets, or screenshots.

Look at this image and extract EVERY event-related field you can find. Use null ONLY when the information is truly not visible.

Return ONLY a JSON object, no markdown or code fences:

{
  "title": "string or null",
  "description": "string or null",
  "start_date": "YYYY-MM-DD or null",
  "start_time": "HH:MM or null",
  "end_date": "YYYY-MM-DD or null",
  "end_time": "HH:MM or null",
  "enrollment_deadline": "YYYY-MM-DD or null",
  "location": "string or null"
}

Rules:
- Dates: use YYYY-MM-DD. Infer year if only day/month shown (use current or next occurrence).
- Times: use HH:MM in 24h format.
- location: venue name, city, or "City, Country".
- enrollment_deadline: registration or ticket deadline if shown.`

function parseExtractedJson(text: string): Record<string, unknown> | null {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) cleaned = match[0]
  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const { image_url } = await req.json()
    if (!image_url || typeof image_url !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_request', message: 'image_url is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }
    try {
      new URL(image_url)
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_request', message: 'image_url must be a valid URL' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    log('request', { image_url })

    const imageResponse = await fetch(image_url, { redirect: 'follow' })
    if (!imageResponse.ok) {
      log('fetch_fail', { status: imageResponse.status })
      return new Response(
        JSON.stringify({ success: false, error: 'fetch_failed', message: `Failed to fetch image: ${imageResponse.statusText}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg'
    const mimeType = contentType.split(';')[0].trim().toLowerCase()
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mimeType)) {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_request', message: 'Unsupported image type' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    const buffer = await imageResponse.arrayBuffer()
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_request', message: 'Image too large' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    const imageBytes = new Uint8Array(buffer)
    log('fetch_ok', { size: imageBytes.byteLength, mimeType })

    const responseText = await generateFromImage(ctx, {
      imageBytes,
      mimeType,
      prompt: EXTRACT_PROMPT,
    })

    const parsed = parseExtractedJson(responseText)
    if (!parsed) {
      log('parse_fail', { reason: 'no_json_match' })
      return new Response(
        JSON.stringify({ success: false, error: 'parse_failed', message: 'Could not parse extraction result' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    let finalStartDate: string | null = null
    let finalEndDate: string | null = null
    if (parsed.start_date) {
      try {
        const date = new Date(parsed.start_date as string)
        if (!isNaN(date.getTime())) {
          finalStartDate = date.toISOString()
          if (parsed.start_time && typeof parsed.start_time === 'string') {
            const [h, m] = parsed.start_time.split(':').map(Number)
            if (!isNaN(h) && !isNaN(m)) {
              date.setHours(h, m, 0, 0)
              finalStartDate = date.toISOString()
            }
          }
        }
      } catch (_e) { /* ignore */ }
    }
    if (parsed.end_date) {
      try {
        const date = new Date(parsed.end_date as string)
        if (!isNaN(date.getTime())) {
          finalEndDate = date.toISOString()
          if (parsed.end_time && typeof parsed.end_time === 'string') {
            const [h, m] = parsed.end_time.split(':').map(Number)
            if (!isNaN(h) && !isNaN(m)) {
              date.setHours(h, m, 0, 0)
              finalEndDate = date.toISOString()
            }
          }
        }
      } catch (_e) { /* ignore */ }
    }

    const extracted = {
      title: parsed.title ?? null,
      description: parsed.description ?? null,
      image_url: image_url as string,
      start_date: finalStartDate,
      end_date: finalEndDate,
      start_time: (parsed.start_time as string) ?? null,
      end_time: (parsed.end_time as string) ?? null,
      enrollment_deadline: parsed.enrollment_deadline ?? null,
      location: parsed.location ?? null,
    }

    log('response', {
      title: extracted.title,
      start_date: extracted.start_date,
      end_date: extracted.end_date,
      location: extracted.location,
    })

    return new Response(
      JSON.stringify({ success: true, extracted, method: 'image' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    )
  } catch (err) {
    if (err instanceof AIError) return aiErrorResponse(err, corsHeaders)
    const message = err instanceof Error ? err.message : 'Unknown error occurred'
    log('error', { message, stack: err instanceof Error ? err.stack : undefined })
    return new Response(
      JSON.stringify({ success: false, error: 'unknown_error', message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }
}
