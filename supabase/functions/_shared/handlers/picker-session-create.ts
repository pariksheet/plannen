// Creates a Google Photos Picker session on behalf of the caller, after
// refreshing their stored Google OAuth access token if it's near expiry.
// Returns the raw Google session object so the UI can render the picker URL.

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

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID')
  const GOOGLE_CLIENT_SECRET = getEnv('GOOGLE_CLIENT_SECRET')
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return jsonResponse({ error: 'Server config error' }, 500)
  }

  const tokenResult = await ctx.db.query(
    `SELECT access_token, expires_at, refresh_token
       FROM plannen.user_oauth_tokens
      WHERE user_id = $1 AND provider = 'google'
      LIMIT 1`,
    [ctx.userId],
  )
  if (tokenResult.rows.length === 0) return jsonResponse({ error: 'Google not connected' }, 404)
  const row = tokenResult.rows[0]

  let accessToken = row.access_token as string | null
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null
  const needRefresh = !accessToken || !expiresAt || expiresAt.getTime() - Date.now() < 5 * 60 * 1000
  if (needRefresh) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        row.refresh_token,
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

  const sessionRes = await fetch('https://photospicker.googleapis.com/v1/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })

  if (!sessionRes.ok) {
    const text = await sessionRes.text()
    console.error('Picker session create failed', sessionRes.status, text)
    return jsonResponse({ error: 'Failed to create picker session', detail: text }, 502)
  }

  const session = await sessionRes.json()
  return jsonResponse(session)
}
