// REST surface for Web Push subscriptions.
//
//   GET    /api/push/vapid-public-key  → public key (or null if unconfigured)
//   POST   /api/push/subscribe         → upsert subscription for current user
//   DELETE /api/push/subscribe         → remove subscription by endpoint
//   POST   /api/push/test              → send a test notification to all of
//                                        the current user's subscriptions

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { sendPush, vapidPublicKey } from '../../_shared/webpush.js'
import type { AppVariables } from '../../types.js'

const SubscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  userAgent: z.string().optional(),
})

const UnsubscribeBody = z.object({ endpoint: z.string().url() })

export const push = new Hono<{ Variables: AppVariables }>()

push.get('/vapid-public-key', (c) => {
  return c.json({ key: vapidPublicKey() })
})

push.post('/subscribe', async (c) => {
  const userId = c.var.userId
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const parsed = SubscribeBody.safeParse(json)
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
  const { endpoint, keys, userAgent } = parsed.data
  await withUserContext(userId, async (db) => {
    await db.query(
      `INSERT INTO plannen.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [userId, endpoint, keys.p256dh, keys.auth, userAgent ?? null],
    )
  })
  return c.json({ ok: true }, 201)
})

push.delete('/subscribe', async (c) => {
  const userId = c.var.userId
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    return c.json({ error: 'invalid json' }, 400)
  }
  const parsed = UnsubscribeBody.safeParse(json)
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
  await withUserContext(userId, async (db) => {
    await db.query(
      'DELETE FROM plannen.push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [userId, parsed.data.endpoint],
    )
  })
  return c.body(null, 204)
})

push.post('/test', async (c) => {
  const userId = c.var.userId
  const result = await sendPush(userId, {
    title: 'Plannen',
    body: 'Push notifications are working.',
    url: '/dashboard',
    tag: 'plannen-test',
  })
  return c.json(result)
})
