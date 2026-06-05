// Web Push helper. Wraps `web-push` with the Plannen pool + per-subscription
// cleanup. VAPID keys live in env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT). If the public key is missing, sendPush is a no-op that
// returns an error in `errors` so callers don't crash on unconfigured envs.

import webpush from 'web-push'
import { pool } from '../db.js'

const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:hello@plannen.app'

let configured = false
let configuredFor: { pub: string; priv: string } | null = null

function ensureConfigured(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return false
  if (configured && configuredFor && configuredFor.pub === pub && configuredFor.priv === priv) {
    return true
  }
  webpush.setVapidDetails(SUBJECT, pub, priv)
  configured = true
  configuredFor = { pub, priv }
  return true
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

export interface PushResult {
  attempted: number
  sent: number
  removed: number
  errors: string[]
}

export async function sendPush(userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { attempted: 0, sent: 0, removed: 0, errors: [] }
  if (!ensureConfigured()) {
    result.errors.push('VAPID keys not configured')
    return result
  }
  const { rows } = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
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
        await pool.query(
          'UPDATE plannen.push_subscriptions SET last_used_at = now() WHERE id = $1',
          [sub.id],
        )
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          await pool.query('DELETE FROM plannen.push_subscriptions WHERE id = $1', [sub.id])
          result.removed += 1
        } else {
          result.errors.push(`${sub.endpoint.slice(0, 40)}…: ${(err as Error).message}`)
        }
      }
    }),
  )
  return result
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null
}
