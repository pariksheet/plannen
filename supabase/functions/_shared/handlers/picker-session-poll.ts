// Polls a Google Photos Picker session, downloads all selected media from
// Google, stores bytes via the local storage REST surface, and inserts an
// event_memories row per item. Tracks attached + skipped sets so the UI
// can show partial-success feedback.
//
// Storage write target: `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/...`.
// On Tier 1 this is the Supabase URL; on Tier 0 it's the backend's own
// /storage/v1/object route (which mirrors Supabase's REST shape).

import { refreshGoogleAccessToken } from '../googleOAuth.ts'
import type { HandlerCtx } from './types.ts'

function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process
  return proc?.env?.[name]
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface PickedMediaItem {
  id: string
  type?: string
  createTime?: string
  mediaFile?: {
    baseUrl?: string
    mimeType?: string
    filename?: string
  }
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heif': 'heif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
}

function pickExtension(filename: string | undefined, contentType: string, itemType: string): string {
  if (filename) {
    const fromName = filename.toLowerCase().split('.').pop()
    if (fromName && fromName.length <= 4 && /^[a-z0-9]+$/.test(fromName)) return fromName
  }
  const ct = (contentType || '').split(';')[0].trim().toLowerCase()
  if (MIME_TO_EXT[ct]) return MIME_TO_EXT[ct]
  if (itemType === 'VIDEO') return 'mp4'
  return 'jpg'
}

function pickMediaType(contentType: string, filename: string | undefined): 'image' | 'video' | 'audio' {
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  if (contentType.startsWith('image/')) return 'image'
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? ''
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio'
  return 'image'
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID')
  const GOOGLE_CLIENT_SECRET = getEnv('GOOGLE_CLIENT_SECRET')
  const STORAGE_PUBLIC_URL_BASE = getEnv('STORAGE_PUBLIC_URL_BASE') ?? getEnv('SUPABASE_URL')
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !STORAGE_PUBLIC_URL_BASE) {
    return jsonResponse({ error: 'Server config error' }, 500)
  }

  let body: { sessionId?: string; eventId?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  const sessionId = body.sessionId
  const eventId = body.eventId
  if (!sessionId || !eventId) return jsonResponse({ error: 'Missing sessionId or eventId' }, 400)

  const tokenResult = await ctx.db.query(
    `SELECT access_token, expires_at, refresh_token
       FROM plannen.user_oauth_tokens
      WHERE user_id = $1 AND provider = 'google'
      LIMIT 1`,
    [ctx.userId],
  )
  if (tokenResult.rows.length === 0) return jsonResponse({ error: 'Google not connected' }, 404)
  const tokenRow = tokenResult.rows[0]

  let accessToken = tokenRow.access_token as string | null
  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at) : null
  const needRefresh = !accessToken || !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000
  if (needRefresh) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        tokenRow.refresh_token,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
      )
      accessToken = access_token
      await ctx.db.query(
        `UPDATE plannen.user_oauth_tokens
            SET access_token = $1,
                expires_at = $2,
                updated_at = $3
          WHERE user_id = $4 AND provider = 'google'`,
        [
          access_token,
          new Date(Date.now() + expires_in * 1000).toISOString(),
          new Date().toISOString(),
          ctx.userId,
        ],
      )
    } catch (e) {
      console.error('Token refresh failed', e)
      return jsonResponse({ error: 'Failed to refresh Google token' }, 502)
    }
  }

  const sessionRes = await fetch(
    `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!sessionRes.ok) {
    const text = await sessionRes.text()
    return jsonResponse({ error: 'Failed to fetch session', detail: text }, 502)
  }
  const session = (await sessionRes.json()) as { mediaItemsSet?: boolean }
  if (!session.mediaItemsSet) {
    return jsonResponse({ status: 'pending' })
  }

  const mediaItems: PickedMediaItem[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ sessionId, pageSize: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const listRes = await fetch(
      `https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!listRes.ok) {
      const text = await listRes.text()
      return jsonResponse({ error: 'Failed to list picker items', detail: text }, 502)
    }
    const page = (await listRes.json()) as { mediaItems?: PickedMediaItem[]; nextPageToken?: string }
    if (page.mediaItems) mediaItems.push(...page.mediaItems)
    pageToken = page.nextPageToken
  } while (pageToken)

  const attached: { external_id: string; memory_id: string; filename?: string }[] = []
  const skipped: { external_id: string; reason: string }[] = []

  for (const item of mediaItems) {
    if (!item.id || !item.mediaFile?.baseUrl) {
      skipped.push({ external_id: item.id ?? '', reason: 'missing id or baseUrl' })
      continue
    }
    if (item.type && item.type !== 'PHOTO' && item.type !== 'VIDEO') {
      skipped.push({ external_id: item.id, reason: `unsupported type ${item.type}` })
      continue
    }

    const existingResult = await ctx.db.query(
      `SELECT id FROM plannen.event_memories
        WHERE event_id = $1 AND external_id = $2
        LIMIT 1`,
      [eventId, item.id],
    )
    if (existingResult.rows.length > 0) {
      attached.push({ external_id: item.id, memory_id: existingResult.rows[0].id, filename: item.mediaFile.filename })
      continue
    }

    const downloadUrl = item.type === 'VIDEO'
      ? `${item.mediaFile.baseUrl}=dv`
      : `${item.mediaFile.baseUrl}=w1280`
    const bytesRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!bytesRes.ok) {
      skipped.push({ external_id: item.id, reason: `download failed ${bytesRes.status}` })
      continue
    }
    const contentType = bytesRes.headers.get('content-type') ?? ''
    const blob = await bytesRes.blob()
    const ext = pickExtension(item.mediaFile?.filename, contentType, item.type ?? '')
    const path = `${eventId}/${ctx.userId}/${item.id}.${ext}`

    const storagePut = await fetch(
      `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/event-photos/${path}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body: blob,
      },
    )
    if (!storagePut.ok) {
      const detail = await storagePut.text().catch(() => '')
      skipped.push({ external_id: item.id, reason: `upload failed: ${detail || storagePut.status}` })
      continue
    }

    const publicUrl = `${STORAGE_PUBLIC_URL_BASE}/storage/v1/object/public/event-photos/${path}`

    const insertResult = await ctx.db.query(
      `INSERT INTO plannen.event_memories (event_id, user_id, source, external_id, media_url, media_type, taken_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        eventId,
        ctx.userId,
        'google_photos',
        item.id,
        publicUrl,
        pickMediaType(contentType, item.mediaFile?.filename),
        item.createTime ?? null,
      ],
    )
    if (insertResult.rows.length === 0) {
      skipped.push({ external_id: item.id, reason: 'insert returned no row' })
      continue
    }
    attached.push({ external_id: item.id, memory_id: insertResult.rows[0].id, filename: item.mediaFile.filename })
  }

  return jsonResponse({
    status: 'complete',
    attached,
    skipped,
    total_selected: mediaItems.length,
  })
}
