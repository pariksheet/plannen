// Returns a fresh Google access token for the caller, refreshing via
// `refresh_token` if it's within 5 minutes of expiring.

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
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405)

  const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID')
  const GOOGLE_CLIENT_SECRET = getEnv('GOOGLE_CLIENT_SECRET')
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return jsonResponse({ error: 'Google OAuth or Supabase not configured' }, 500)
  }

  const tokenResult = await ctx.db.query(
    `SELECT access_token, expires_at, refresh_token
       FROM plannen.user_oauth_tokens
      WHERE user_id = $1 AND provider = 'google'
      LIMIT 1`,
    [ctx.userId],
  )
  if (tokenResult.rows.length === 0) {
    return jsonResponse({ error: 'Google not connected or invalid token' }, 404)
  }
  const row = tokenResult.rows[0]

  const now = new Date()
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null
  const needRefresh = !row.access_token || !expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000

  let accessToken: string | null = row.access_token
  if (needRefresh) {
    try {
      const { access_token, expires_in } = await refreshGoogleAccessToken(
        row.refresh_token,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
      )
      accessToken = access_token
      const newExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString()
      await ctx.db.query(
        `UPDATE plannen.user_oauth_tokens
            SET access_token = $1,
                expires_at = $2,
                updated_at = $3
          WHERE user_id = $4 AND provider = 'google'`,
        [access_token, newExpiresAt, new Date().toISOString(), ctx.userId],
      )
    } catch (e) {
      console.error('Google token refresh failed', e)
      return jsonResponse({ error: 'Failed to refresh Google token' }, 502)
    }
  }

  return jsonResponse({ access_token: accessToken })
}
