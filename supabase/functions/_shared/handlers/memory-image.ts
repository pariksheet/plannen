// Proxies binary photo/video bytes from Google Drive / Photos for the
// currently-selected event memory. Returns 302 to the cached public URL
// if `media_url` is already set on the row.
//
// Tier 0 is single-user, so the photo owner is always the caller. On
// Tier 1, RLS scopes both selects to the caller; cross-user shared
// memories that previously needed service-role lookups now share the
// same auth context (single-user app).

import { refreshGoogleAccessToken } from '../googleOAuth.ts'
import type { HandlerCtx } from './types.ts'

// Env access via the global `process` shim. Deno's Node-compat layer
// exposes `process.env` (Deno 1.24+), and Node reads it natively; we
// reach through `globalThis` to avoid needing Node-only ambient types
// in the handler source.
function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process
  return proc?.env?.[name]
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

interface MemoryRow {
  id: string
  event_id: string
  user_id: string
  source: string
  external_id: string | null
  media_url: string | null
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const url = new URL(req.url)
  const memoryId = url.searchParams.get('memory_id') ?? url.pathname.split('/').filter(Boolean).pop()
  if (!memoryId) return new Response('Missing memory_id', { status: 400 })

  const memoryResult = await ctx.db.query(
    `SELECT id, event_id, user_id, source, external_id, media_url
       FROM plannen.event_memories
      WHERE id = $1
      LIMIT 1`,
    [memoryId],
  )
  if (memoryResult.rows.length === 0) return new Response('Not found', { status: 404 })
  const row = memoryResult.rows[0] as MemoryRow

  // Bytes already cached in storage (manual upload or picker import) — redirect to public URL.
  if (row.media_url) {
    return Response.redirect(row.media_url, 302)
  }

  if (row.source === 'upload') {
    return new Response('No photo URL', { status: 404 })
  }

  if (row.source !== 'google_drive' && row.source !== 'google_photos') {
    return new Response('Unsupported source', { status: 400 })
  }
  if (!row.external_id) return new Response('Missing external_id', { status: 400 })

  // Photo owner's OAuth tokens (RLS scopes to caller; in single-user app
  // row.user_id == ctx.userId).
  const tokenResult = await ctx.db.query(
    `SELECT access_token, expires_at, refresh_token
       FROM plannen.user_oauth_tokens
      WHERE user_id = $1 AND provider = 'google'
      LIMIT 1`,
    [row.user_id],
  )
  if (tokenResult.rows.length === 0) {
    return new Response('Photo owner has not connected Google', { status: 403 })
  }
  const tokenRow = tokenResult.rows[0]

  let accessToken = tokenRow.access_token as string | null
  const now = new Date()
  const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at) : null
  const needRefresh = !accessToken || !expiresAt || expiresAt.getTime() - now.getTime() < 60 * 1000

  if (needRefresh && getEnv('GOOGLE_CLIENT_ID') && getEnv('GOOGLE_CLIENT_SECRET')) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        tokenRow.refresh_token,
        getEnv('GOOGLE_CLIENT_ID')!,
        getEnv('GOOGLE_CLIENT_SECRET')!,
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
          row.user_id,
        ],
      )
    } catch (e) {
      console.error('Token refresh failed', e)
      return new Response('Failed to refresh token', { status: 502 })
    }
  }

  if (!accessToken) return new Response('No access token', { status: 502 })

  try {
    if (row.source === 'google_drive') {
      const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.external_id)}?alt=media`
      const driveRes = await fetch(driveUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!driveRes.ok) {
        return new Response('Photo unavailable', { status: driveRes.status === 404 ? 404 : 502 })
      }
      const contentType = driveRes.headers.get('Content-Type') ?? 'image/jpeg'
      return new Response(driveRes.body, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=300',
          ...corsHeaders,
        },
      })
    }

    if (row.source === 'google_photos') {
      const metaRes = await fetch(
        `https://photoslibrary.googleapis.com/v1/mediaItems/${encodeURIComponent(row.external_id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!metaRes.ok) {
        return new Response('Photo unavailable', { status: metaRes.status === 404 ? 404 : 502 })
      }
      const meta = (await metaRes.json()) as { baseUrl?: string }
      const baseUrl = meta.baseUrl
      if (!baseUrl) return new Response('Photo URL not available', { status: 502 })
      const mediaUrl = baseUrl.includes('?') ? `${baseUrl}&access_token=${accessToken}` : `${baseUrl}?access_token=${accessToken}`
      const mediaRes = await fetch(mediaUrl)
      if (!mediaRes.ok) return new Response('Photo unavailable', { status: 502 })
      const contentType = mediaRes.headers.get('Content-Type') ?? 'image/jpeg'
      return new Response(mediaRes.body, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=300',
          ...corsHeaders,
        },
      })
    }
  } catch (e) {
    console.error('Proxy fetch failed', e)
    return new Response('Failed to load photo', { status: 502 })
  }

  return new Response('Unsupported source', { status: 400 })
}
