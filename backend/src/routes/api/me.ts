import { Hono } from 'hono'
import type { AppVariables } from '../../types.js'

export const me = new Hono<{ Variables: AppVariables }>()

me.get('/', (c) => {
  return c.json({ data: { userId: c.var.userId, email: c.var.userEmail } })
})
