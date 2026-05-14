import { Hono } from 'hono'
import { withUserContext } from '../../db.js'
import type { AppVariables } from '../../types.js'

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
