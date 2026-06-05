// Shared push handlers. Imported by:
//   • supabase/functions/push-*           (Tier 1/2 edge runtime via npm:web-push)
//   • backend/src/routes/functions/push-* (Tier 0 Node runtime — overlay version
//     mirrors this with a node import)
//
// Keep this file Deno-runnable: use `npm:web-push@3` and Web Crypto / fetch
// rather than node:crypto.

import webpush from 'npm:web-push@3.6.7'
import type { HandlerCtx } from './types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  return null
}

// Dual-runtime env access. In Deno (Tier 1/2 edge) we read Deno.env; in Node
// (Tier 0 backend, after prepare-shared rewrites the npm:* specifier) we read
// process.env. Pull both through globalThis so neither typechecker complains
// about the absent global in its own environment.
function getEnv(key: string): string | undefined {
  const g = globalThis as { Deno?: { env?: { get(k: string): string | undefined } }; process?: { env?: Record<string, string | undefined> } }
  if (g.Deno?.env?.get) return g.Deno.env.get(key)
  return g.process?.env?.[key]
}

let vapidConfigured: { pub: string; priv: string } | null = null
function ensureConfigured(): boolean {
  const pub = getEnv('VAPID_PUBLIC_KEY')
  const priv = getEnv('VAPID_PRIVATE_KEY')
  const subject = getEnv('VAPID_SUBJECT') ?? 'mailto:hello@plannen.app'
  if (!pub || !priv) return false
  if (vapidConfigured && vapidConfigured.pub === pub && vapidConfigured.priv === priv) return true
  webpush.setVapidDetails(subject, pub, priv)
  vapidConfigured = { pub, priv }
  return true
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

export async function sendPush(db: HandlerCtx['db'], userId: string, payload: PushPayload): Promise<{
  attempted: number
  sent: number
  removed: number
  errors: string[]
}> {
  const result = { attempted: 0, sent: 0, removed: 0, errors: [] as string[] }
  if (!ensureConfigured()) {
    result.errors.push('VAPID keys not configured')
    return result
  }
  const { rows } = await db.query(
    'SELECT id, endpoint, p256dh, auth FROM plannen.push_subscriptions WHERE user_id = $1',
    [userId],
  )
  result.attempted = rows.length
  const body = JSON.stringify(payload)
  await Promise.all(
    rows.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        )
        result.sent += 1
        await db.query(
          'UPDATE plannen.push_subscriptions SET last_used_at = now() WHERE id = $1',
          [sub.id],
        )
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          await db.query('DELETE FROM plannen.push_subscriptions WHERE id = $1', [sub.id])
          result.removed += 1
        } else {
          result.errors.push(`${String(sub.endpoint).slice(0, 40)}…: ${(err as Error).message}`)
        }
      }
    }),
  )
  return result
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleVapidPublicKey(req: Request): Promise<Response> {
  const pre = preflight(req)
  if (pre) return pre
  return jsonResp(200, { key: getEnv('VAPID_PUBLIC_KEY') ?? null })
}

interface SubscribeBody {
  endpoint?: string
  keys?: { p256dh?: string; auth?: string }
  userAgent?: string
}

function isValidSubscribe(body: SubscribeBody): body is Required<SubscribeBody> & { keys: { p256dh: string; auth: string } } {
  return typeof body?.endpoint === 'string' &&
    /^https?:\/\//.test(body.endpoint) &&
    typeof body?.keys?.p256dh === 'string' &&
    body.keys.p256dh.length > 0 &&
    typeof body?.keys?.auth === 'string' &&
    body.keys.auth.length > 0
}

export async function handleSubscribe(req: Request, ctx: HandlerCtx): Promise<Response> {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return jsonResp(405, { error: 'method_not_allowed' })
  let body: SubscribeBody
  try {
    body = await req.json()
  } catch {
    return jsonResp(400, { error: 'invalid_json' })
  }
  if (!isValidSubscribe(body)) return jsonResp(400, { error: 'invalid_body' })
  await ctx.db.query(
    `INSERT INTO plannen.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, endpoint)
     DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [ctx.userId, body.endpoint, body.keys.p256dh, body.keys.auth, body.userAgent ?? null],
  )
  return jsonResp(201, { ok: true })
}

export async function handleUnsubscribe(req: Request, ctx: HandlerCtx): Promise<Response> {
  const pre = preflight(req)
  if (pre) return pre
  // Some clients can't send a body on DELETE; accept POST as an alias.
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return jsonResp(405, { error: 'method_not_allowed' })
  }
  let body: { endpoint?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResp(400, { error: 'invalid_json' })
  }
  if (typeof body?.endpoint !== 'string') return jsonResp(400, { error: 'invalid_body' })
  await ctx.db.query(
    'DELETE FROM plannen.push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [ctx.userId, body.endpoint],
  )
  return new Response(null, { status: 204, headers: corsHeaders })
}

export async function handleTest(req: Request, ctx: HandlerCtx): Promise<Response> {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return jsonResp(405, { error: 'method_not_allowed' })
  const result = await sendPush(ctx.db, ctx.userId, {
    title: 'Plannen',
    body: 'Push notifications are working.',
    url: '/dashboard',
    tag: 'plannen-test',
  })
  return jsonResp(200, result)
}
