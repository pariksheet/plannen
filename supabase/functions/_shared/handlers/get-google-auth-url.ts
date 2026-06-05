// Builds the Google OAuth consent URL and records the random `state` value
// in `plannen.oauth_state` so the callback can match it back to the user.

import type { HandlerCtx } from './types.ts'

function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process
  return proc?.env?.[name]
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const PHOTOS_PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID')
  const SUPABASE_URL = getEnv('SUPABASE_URL')
  const GOOGLE_OAUTH_REDIRECT_URI = getEnv('GOOGLE_OAUTH_REDIRECT_URI')
  if (!GOOGLE_CLIENT_ID) {
    return jsonResponse({ error: 'Google OAuth or Supabase not configured' }, 500)
  }

  const state = crypto.randomUUID()
  const redirectUri =
    GOOGLE_OAUTH_REDIRECT_URI ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/google-oauth-callback` : null)
  if (!redirectUri) {
    return jsonResponse({ error: 'Google OAuth redirect URI not configured' }, 500)
  }
  const scope = [DRIVE_SCOPE, PHOTOS_PICKER_SCOPE].join(' ')
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`

  try {
    await ctx.db.query(
      `INSERT INTO plannen.oauth_state (state, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [state, ctx.userId, new Date(Date.now() + 10 * 60 * 1000).toISOString()],
    )
  } catch (e) {
    console.error('Failed to insert oauth_state', e)
    return jsonResponse({ error: 'Failed to create state' }, 500)
  }

  return jsonResponse({ url, state })
}
