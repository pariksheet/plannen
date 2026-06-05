// Handles the redirect from Google's OAuth consent screen. Looks up the
// `oauth_state` row by the random `state`, exchanges the `code` for tokens,
// and upserts a `user_oauth_tokens` row keyed by (user_id, 'google').
//
// Unlike other handlers, this one has NO user JWT in the incoming request
// (Google does the redirect on the user's behalf). The owning user_id is
// recovered from the oauth_state row. In Tier 0 the backend route still
// runs inside the single resolved user's context; in Tier 1 the Deno entry
// uses a service-role db client.

import type { HandlerCtx } from './types.ts'

function getEnv(name: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process
  return proc?.env?.[name]
}

function redirect(url: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: url } })
}

export async function handle(req: Request, ctx: HandlerCtx): Promise<Response> {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')

  const APP_OAUTH_REDIRECT_URL = getEnv('APP_OAUTH_REDIRECT_URL') ?? 'http://localhost:4321/dashboard'
  const baseRedirect = APP_OAUTH_REDIRECT_URL.replace(/\?.*$/, '')
  const append = (params: Record<string, string>) => {
    const q = new URLSearchParams(params)
    return `${baseRedirect}?${q.toString()}`
  }

  if (errorParam) {
    return redirect(append({ google_oauth: 'error', error: errorParam }))
  }
  if (!code || !state) {
    return redirect(append({ google_oauth: 'error', error: 'missing_code_or_state' }))
  }

  const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID')
  const GOOGLE_CLIENT_SECRET = getEnv('GOOGLE_CLIENT_SECRET')
  const SUPABASE_URL = getEnv('SUPABASE_URL')
  const GOOGLE_OAUTH_REDIRECT_URI = getEnv('GOOGLE_OAUTH_REDIRECT_URI')
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return redirect(append({ google_oauth: 'error', error: 'server_config' }))
  }

  const stateResult = await ctx.db.query(
    `SELECT user_id FROM plannen.oauth_state
      WHERE state = $1 AND expires_at > $2
      LIMIT 1`,
    [state, new Date().toISOString()],
  )
  if (stateResult.rows.length === 0) {
    return redirect(append({ google_oauth: 'error', error: 'invalid_or_expired_state' }))
  }
  const stateUserId = stateResult.rows[0].user_id as string

  await ctx.db.query('DELETE FROM plannen.oauth_state WHERE state = $1', [state])

  const redirectUri =
    GOOGLE_OAUTH_REDIRECT_URI ?? (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/google-oauth-callback` : '')
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    console.error('Google token exchange failed', tokenRes.status, errText)
    return redirect(append({ google_oauth: 'error', error: 'token_exchange_failed' }))
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  if (!tokens.refresh_token) {
    return redirect(append({ google_oauth: 'error', error: 'no_refresh_token' }))
  }

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null

  try {
    await ctx.db.query(
      `INSERT INTO plannen.user_oauth_tokens
         (user_id, provider, refresh_token, access_token, expires_at, scopes, updated_at)
       VALUES ($1, 'google', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         refresh_token = EXCLUDED.refresh_token,
         access_token = EXCLUDED.access_token,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = EXCLUDED.updated_at`,
      [
        stateUserId,
        tokens.refresh_token,
        tokens.access_token,
        expiresAt,
        'drive.readonly photospicker.mediaitems.readonly',
        new Date().toISOString(),
      ],
    )
  } catch (e) {
    console.error('Failed to store tokens', e)
    return redirect(append({ google_oauth: 'error', error: 'save_failed' }))
  }

  return redirect(append({ google_oauth: 'success' }))
}
