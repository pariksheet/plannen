import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { generateStructured, aiErrorResponse, AIError } from '../_shared/ai.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const LOG_PREFIX = '[agent-scrape]'
function log(event: string, data?: Record<string, unknown>) {
  const payload = data ? ` ${JSON.stringify(data)}` : ''
  console.log(`${LOG_PREFIX} ${event}${payload}`)
}

const ExtractedEvent = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  enrollment_deadline: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
})

type ExtractedEventT = z.infer<typeof ExtractedEvent>

// Extract JSON-LD Event or Article from page (has startDate, endDate, location)
function extractStructuredData(html: string): {
  start_date: string | null
  end_date: string | null
  location: string | null
  title: string | null
} {
  const out = { start_date: null as string | null, end_date: null as string | null, location: null as string | null, title: null as string | null }
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let scriptMatch: RegExpExecArray | null
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const openTag = scriptMatch[0].substring(0, scriptMatch[0].indexOf('>') + 1)
    if (!/type\s*=\s*["']application\/ld\+json["']/i.test(openTag)) continue
    const inner = scriptMatch[1].trim()
    try {
      // deno-lint-ignore no-explicit-any
      const data = JSON.parse(inner) as any
      // deno-lint-ignore no-explicit-any
      const items = Array.isArray(data) ? data : data['@graph'] ? (data['@graph'] as any[]) : [data]
      for (const item of items) {
        const type = (item['@type'] || '').toLowerCase()
        if (type !== 'event' && type !== 'theatreevent' && !type.includes('event')) continue
        if (item.startDate) {
          const d = String(item.startDate)
          out.start_date = d.length >= 10 ? d.substring(0, 10) : d
        }
        if (item.endDate) {
          const d = String(item.endDate)
          out.end_date = d.length >= 10 ? d.substring(0, 10) : d
        }
        if (item.location) {
          const loc = item.location
          out.location = typeof loc === 'string' ? loc : (loc?.name || loc?.address?.streetAddress || null)
        }
        if (item.name) out.title = item.name
        if (out.start_date || out.end_date || out.location || out.title) break
      }
      if (out.start_date || out.end_date || out.location || out.title) break
    } catch (_e) { /* ignore */ }
  }
  return out
}

// Parse a date hint string to YYYY-MM-DD (for fallback when LLM returns null)
function parseDateHintToISO(hint: string): string | null {
  const s = hint.trim()
  const isoMatch = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return isoMatch[0]
  const monthNames: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
    august: 7, september: 8, october: 9, november: 10, december: 11,
  }
  let longMatch = s.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december),?\s+(\d{2,4})/i)
  if (longMatch) {
    const day = parseInt(longMatch[1], 10)
    const month = monthNames[longMatch[2].toLowerCase()]
    let year = parseInt(longMatch[3], 10)
    year = year < 100 ? (year < 50 ? 2000 + year : 1900 + year) : year
    if (month !== undefined && day >= 1 && day <= 31) {
      const d = new Date(year, month, day)
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
  }
  longMatch = s.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{2,4})?/i)
  if (longMatch) {
    const month = monthNames[longMatch[1].toLowerCase()]
    const day = parseInt(longMatch[2], 10)
    let year = longMatch[3] ? parseInt(longMatch[3], 10) : new Date().getFullYear()
    year = year < 100 ? (year < 50 ? 2000 + year : 1900 + year) : year
    if (month !== undefined && day >= 1 && day <= 31) {
      const d = new Date(year, month, day)
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
  }
  return null
}

function extractDateHints(html: string): string[] {
  const hints: string[] = []
  const timeRegex = /<time[^>]+datetime=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = timeRegex.exec(html)) !== null) {
    const val = m[1].trim()
    if (val && val.length >= 6) hints.push(`Date (time tag): ${val}`)
  }
  const bodyText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  const datePhrases = bodyText.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}\b/gi)
  if (datePhrases) {
    const uniq = [...new Set(datePhrases.slice(0, 5))]
    uniq.forEach((p) => hints.push(`Date in text: ${p.trim()}`))
  }
  const dayMonth = bodyText.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/gi)
  if (dayMonth) {
    const uniq = [...new Set(dayMonth.slice(0, 5))]
    uniq.forEach((p) => hints.push(`Date in text: ${p.trim()}`))
  }
  return hints
}

function extractTextContent(html: string, maxLength: number = 14000): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  const contentTags = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'td', 'th', 'span', 'div']
  const extracted: string[] = []
  for (const tag of contentTags) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
    const matches = text.match(regex)
    if (matches) {
      matches.forEach((match) => {
        const content = match.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (content.length > 2 && content.length <= 600) extracted.push(content)
      })
    }
  }
  let result = extracted.join('\n').replace(/\n+/g, '\n').trim()
  if (result.length > maxLength) result = result.substring(0, maxLength) + '...'
  return result
}

function resolveImageHref(href: string, baseUrl: string): string | null {
  const h = href.trim()
  if (h.startsWith('http')) return h
  if (h.startsWith('//')) return `https:${h}`
  if (h.startsWith('data:') || h.startsWith('#')) return null
  try {
    return new URL(h, baseUrl).href
  } catch { return null }
}

function extractImageUrl(html: string, baseUrl: string): string | null {
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  if (ogImage?.[1]) {
    const resolved = resolveImageHref(ogImage[1], baseUrl)
    if (resolved) return resolved
  }
  const twImage = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)
  if (twImage?.[1]) {
    const resolved = resolveImageHref(twImage[1], baseUrl)
    if (resolved) return resolved
  }
  const imgInArticle = html.match(/<article[^>]*>[\s\S]*?<img[^>]+(?:src=["']([^"']+)["']|data-src=["']([^"']+)["'])/i)
  if (imgInArticle?.[1] || imgInArticle?.[2]) {
    const href = (imgInArticle[1] || imgInArticle[2]).trim()
    const resolved = resolveImageHref(href, baseUrl)
    if (resolved) return resolved
  }
  const imgInMain = html.match(/<main[^>]*>[\s\S]*?<img[^>]+(?:src=["']([^"']+)["']|data-src=["']([^"']+)["'])/i)
  if (imgInMain?.[1] || imgInMain?.[2]) {
    const href = (imgInMain[1] || imgInMain[2]).trim()
    const resolved = resolveImageHref(href, baseUrl)
    if (resolved) return resolved
  }
  const imgRegex = /<img[^>]+(?:src=["']([^"']+)["']|data-src=["']([^"']+)["'])[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = imgRegex.exec(html)) !== null) {
    const href = (m[1] || m[2] || '').trim()
    if (!href || /favicon|icon\.(png|ico)|logo\.(png|jpg|svg)|spacer|pixel|1x1|\.ico\b/i.test(href)) continue
    const resolved = resolveImageHref(href, baseUrl)
    if (resolved) return resolved
  }
  return null
}

async function extractWithLLM(
  req: Request,
  html: string,
  url: string,
  dateHints: string[],
  structured: { start_date: string | null; end_date: string | null; location: string | null; title: string | null },
): Promise<ExtractedEventT | null> {
  try {
    const textContent = extractTextContent(html, 14000)
    const hintsSection = dateHints.length > 0
      ? `\n\nExplicit dates found in the page (you MUST use these when filling start_date, end_date, or enrollment_deadline):\n${dateHints.join('\n')}\n`
      : ''
    const structuredSection =
      structured.start_date || structured.end_date || structured.location || structured.title
        ? `\n\nStructured data from page (prefer these if present): start_date=${structured.start_date ?? 'null'}, end_date=${structured.end_date ?? 'null'}, location=${structured.location ?? 'null'}, title=${structured.title ?? 'null'}\n`
        : ''

    const prompt = `You are an expert at extracting event information from web pages. Fill in EVERY field you can find. Use null ONLY when the information is truly not mentioned.${hintsSection}${structuredSection}

URL: ${url}

Text from the page:
${textContent}

RULES:
- start_date / end_date: event date(s). Convert any date to YYYY-MM-DD. Use the "Explicit dates" or "Structured data" above if given.
- enrollment_deadline: when tickets go on sale, or registration deadline.
- location: venue name, city, or "City, Country".`

    const parsed = await generateStructured(req, {
      prompt,
      schema: ExtractedEvent,
    })

    // Merge structured-data fallbacks over nulls
    if (structured.start_date && !parsed.start_date) parsed.start_date = structured.start_date
    if (structured.end_date && !parsed.end_date) parsed.end_date = structured.end_date
    if (structured.location && !parsed.location) parsed.location = structured.location
    if (structured.title && !parsed.title) parsed.title = structured.title

    return parsed
  } catch (err) {
    if (err instanceof AIError && err.code === 'no_provider_configured') {
      log('llm_skipped', { reason: 'no_provider_configured' })
      return null
    }
    console.error('LLM extraction error:', err)
    return null
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { url, event_id } = body
    if (!url) {
      return new Response(
        JSON.stringify({ success: false, error: 'invalid_request', message: 'url is required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }
    log('request', { url, event_id: event_id ?? null })

    const authHeader = req.headers.get('Authorization')
    if (event_id && !authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: 'unauthorized', message: 'Authorization required when updating an event' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseClient = authHeader != null
      ? createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } })
      : null

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0.4472.124 Safari/537.36' },
    })
    if (!response.ok) {
      return new Response(
        JSON.stringify({ success: false, error: 'fetch_failed', message: `Failed to fetch URL: ${response.statusText}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    const html = await response.text()
    log('fetch', { htmlLength: html.length, status: response.status })

    const extractedImageUrl = extractImageUrl(html, url)
    const structured = extractStructuredData(html)
    const dateHints = extractDateHints(html)
    log('structured', {
      imageUrl: extractedImageUrl ? 'yes' : 'no',
      start_date: structured.start_date,
      end_date: structured.end_date,
      location: structured.location,
      title: structured.title,
      dateHintsCount: dateHints.length,
    })

    const extractedData = await extractWithLLM(req, html, url, dateHints, structured)
    if (!extractedData) log('llm_result', { used: false })

    const parsedHints = dateHints.map(parseDateHintToISO).filter((d): d is string => d != null)
    const applyDateHintFallback = (obj: ExtractedEventT) => {
      if (!obj.start_date && parsedHints[0]) obj.start_date = parsedHints[0]
      if (!obj.end_date && parsedHints[1]) obj.end_date = parsedHints[1]
      if (!obj.enrollment_deadline && (parsedHints[2] || parsedHints[1])) {
        obj.enrollment_deadline = parsedHints[2] ?? parsedHints[1]
      }
    }

    if (extractedData) {
      applyDateHintFallback(extractedData)

      let finalStartDate: string | null = null
      let finalEndDate: string | null = null
      if (extractedData.start_date) {
        try {
          const date = new Date(extractedData.start_date)
          if (!isNaN(date.getTime())) {
            finalStartDate = date.toISOString()
            if (extractedData.start_time) {
              const [h, m] = extractedData.start_time.split(':').map(Number)
              date.setHours(h, m, 0, 0)
              finalStartDate = date.toISOString()
            }
          }
        } catch (_e) { /* ignore */ }
      }
      if (extractedData.end_date) {
        try {
          const date = new Date(extractedData.end_date)
          if (!isNaN(date.getTime())) {
            finalEndDate = date.toISOString()
            if (extractedData.end_time) {
              const [h, m] = extractedData.end_time.split(':').map(Number)
              date.setHours(h, m, 0, 0)
              finalEndDate = date.toISOString()
            }
          }
        } catch (_e) { /* ignore */ }
      }

      if (event_id && supabaseClient) {
        // deno-lint-ignore no-explicit-any
        const updateData: any = {}
        if (extractedData.title) updateData.title = extractedData.title
        if (finalStartDate) updateData.start_date = finalStartDate
        if (finalEndDate) updateData.end_date = finalEndDate
        const imageUrl = extractedData.image_url || extractedImageUrl
        if (imageUrl) updateData.image_url = imageUrl
        if (extractedData.location) updateData.location = extractedData.location
        if (extractedData.enrollment_deadline) {
          try {
            const deadline = new Date(extractedData.enrollment_deadline)
            if (!isNaN(deadline.getTime())) updateData.enrollment_deadline = deadline.toISOString()
          } catch (_e) { /* ignore */ }
        }
        if (Object.keys(updateData).length > 0) {
          await supabaseClient.from('events').update(updateData).eq('id', event_id)
        }
      }

      log('response_llm', {
        method: 'llm',
        title: extractedData.title ?? null,
        start_date: finalStartDate,
        end_date: finalEndDate,
        enrollment_deadline: extractedData.enrollment_deadline ?? null,
        location: extractedData.location ?? null,
      })

      return new Response(
        JSON.stringify({
          success: true,
          extracted: {
            title: extractedData.title ?? null,
            description: extractedData.description ?? null,
            image_url: extractedData.image_url || extractedImageUrl,
            start_date: finalStartDate,
            end_date: finalEndDate,
            start_time: extractedData.start_time ?? null,
            end_time: extractedData.end_time ?? null,
            enrollment_deadline: extractedData.enrollment_deadline ?? null,
            location: extractedData.location ?? null,
          },
          method: 'llm',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
      )
    }

    // Regex fallback: title from h1/title; dates from structured (JSON-LD) or dateHints
    let extractedTitle: string | null = structured.title ?? null
    if (!extractedTitle) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
      if (h1Match) extractedTitle = h1Match[1].trim().replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    }
    if (!extractedTitle) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      if (titleMatch) extractedTitle = titleMatch[1].split('|')[0].split('-')[0].trim()
    }

    const regexStartDate = structured.start_date || parsedHints[0] || null
    const regexEndDate = structured.end_date || parsedHints[1] || null
    const regexEnrollmentDeadline = parsedHints[2] || parsedHints[1] || null

    log('response_regex', {
      method: 'regex',
      title: extractedTitle ?? null,
      start_date: regexStartDate,
      end_date: regexEndDate,
      enrollment_deadline: regexEnrollmentDeadline,
      location: structured.location,
    })

    return new Response(
      JSON.stringify({
        success: true,
        extracted: {
          title: extractedTitle,
          description: null,
          image_url: extractedImageUrl,
          start_date: regexStartDate,
          end_date: regexEndDate,
          start_time: null,
          end_time: null,
          enrollment_deadline: regexEnrollmentDeadline,
          location: structured.location,
        },
        method: 'regex',
      }),
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
})
