import { Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { withUserContext } from '../../db.js'
import { signupOrSwitch } from '../../auth.js'
import { setIdentity } from '../../_shared/identity.js'
import { updateEnvFile } from '../../_shared/rewriteEnv.js'
import type { AppVariables } from '../../types.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export const me = new Hono<{ Variables: AppVariables }>()

me.get('/', async (c) => {
  const userId = c.var.userId
  const email = c.var.userEmail
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT full_name, avatar_url FROM plannen.users WHERE id = $1',
      [userId],
    )
    const u = rows[0] ?? {}
    return c.json({
      data: {
        userId,
        email,
        full_name: u.full_name ?? null,
        avatar_url: u.avatar_url ?? null,
      },
    })
  })
})

// Tier-0 web-UI signup / identity switch. Body: { email }. Creates the
// auth.users + plannen.users rows if missing, rewrites PLANNEN_USER_EMAIL in
// .env (best-effort — the in-memory identity is mutated regardless so the
// current process picks up the change immediately), then returns the resolved
// user in the same shape as GET /.
me.post('/', async (c) => {
  // LN-01 (#10): identity switching is a Tier-0-only, local-console feature —
  // it swaps the active identity and rewrites the backend's env file.
  // Tier guard: on any cloud/multi-user tier this route does not exist.
  // Read fresh per request, matching how the identity itself is resolved.
  if ((process.env.PLANNEN_TIER ?? '0') !== '0') {
    return c.json({ error: 'not found' }, 404)
  }
  // Loopback guard: refuse callers that reached us over a non-loopback socket
  // (misconfigured proxy, HOST override). In-process test requests have no
  // socket info — the tier guard above still applies there.
  try {
    const addr = getConnInfo(c).remote.address
    if (addr && !LOOPBACK.has(addr)) {
      return c.json({ error: 'forbidden' }, 403)
    }
  } catch { /* no conninfo (non-socket request) */ }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'body must be JSON' }, 400)
  }
  const email = typeof (body as { email?: unknown })?.email === 'string'
    ? ((body as { email: string }).email).trim().toLowerCase()
    : ''
  if (!email || !email.includes('@')) {
    return c.json({ error: 'invalid email' }, 400)
  }

  const resolved = await signupOrSwitch(email)
  setIdentity(resolved)

  // Persist so a backend restart sees the same identity. Best-effort —
  // PLANNEN_ENV_PATH is set by backend-start.sh; if it's missing or unwritable
  // the in-memory switch still works for the current process.
  const envPath = process.env.PLANNEN_ENV_PATH
  if (envPath) {
    try {
      updateEnvFile(envPath, 'PLANNEN_USER_EMAIL', resolved.email)
    } catch (e) {
      console.warn(`POST /api/me: failed to update ${envPath}: ${(e as Error).message}`)
    }
  }

  return await withUserContext(resolved.userId, async (db) => {
    const { rows } = await db.query(
      'SELECT full_name, avatar_url FROM plannen.users WHERE id = $1',
      [resolved.userId],
    )
    const u = rows[0] ?? {}
    return c.json({
      data: {
        userId: resolved.userId,
        email: resolved.email,
        full_name: u.full_name ?? null,
        avatar_url: u.avatar_url ?? null,
      },
    })
  })
})
