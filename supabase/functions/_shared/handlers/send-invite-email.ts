// Sends a magic-link invitation email via Mailgun. No DB writes — purely a
// wrapper around the Mailgun REST API. The caller's auth context isn't used
// other than implicitly gating who can trigger an invite (the route mount).

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

export async function handle(req: Request, _ctx: HandlerCtx): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const MAILGUN_API_KEY = getEnv('MAILGUN_API_KEY')
  const MAILGUN_DOMAIN = getEnv('MAILGUN_DOMAIN')
  const MAILGUN_FROM_EMAIL = getEnv('MAILGUN_FROM_EMAIL')
  const MAILGUN_FROM_NAME = getEnv('MAILGUN_FROM_NAME') ?? 'Plannen'
  const APP_LOGIN_URL = getEnv('APP_LOGIN_URL') ?? 'http://localhost:4321/login'

  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    return jsonResponse(
      { error: 'Mailgun is not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN.' },
      500,
    )
  }

  let body: { email?: string }
  try {
    body = (await req.json()) as { email?: string }
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const to = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!to || !to.includes('@')) {
    return jsonResponse({ error: 'Valid email is required' }, 400)
  }

  const fromEmail = (MAILGUN_FROM_EMAIL ?? `invites@${MAILGUN_DOMAIN}`).trim()
  if (!fromEmail.includes('@')) {
    return jsonResponse({ error: 'MAILGUN_FROM_EMAIL must be a valid email address.' }, 500)
  }
  const from = `${MAILGUN_FROM_NAME} <${fromEmail}>`
  const subject = "You're invited to Plannen"
  const text = `You've been invited to Plannen — social event planning with friends and family.\n\nSign in with this email to get started (we'll send you a magic link):\n${APP_LOGIN_URL}\n\nIf you didn't expect this invite, you can ignore this email.`
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;">
<p>You've been invited to <strong>Plannen</strong> — social event planning with friends and family.</p>
<p><a href="${APP_LOGIN_URL}" style="background:#4f46e5;color:white;padding:10px 16px;text-decoration:none;border-radius:6px;display:inline-block;">Sign in with this email</a></p>
<p>We'll send you a magic link to log in. If you didn't expect this invite, you can ignore this email.</p>
</body></html>`

  const form = new FormData()
  form.append('from', from)
  form.append('to', to)
  form.append('subject', subject)
  form.append('text', text)
  form.append('html', html)

  const mailgunUrl = `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`
  const res = await fetch(mailgunUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa('api:' + MAILGUN_API_KEY),
    },
    body: form,
  })

  if (!res.ok) {
    const errText = await res.text()
    return jsonResponse({ error: 'Mailgun error', details: errText }, 502)
  }

  return jsonResponse({ ok: true }, 200)
}
