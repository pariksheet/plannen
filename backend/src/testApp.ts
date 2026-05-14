// Factory for integration tests. Builds an isolated Hono app with the same
// middleware + routes as the production entry point, but with the resolved
// user injected directly instead of read from PLANNEN_USER_EMAIL.

import { Hono } from 'hono'
import { pool } from './db.js'
import { errorMiddleware } from './middleware/error.js'
import { health } from './health.js'
import { me } from './routes/api/me.js'
import type { AppVariables } from './types.js'

export function buildApp(user: { userId: string; userEmail: string }) {
  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', errorMiddleware)
  app.use('*', async (c, next) => {
    c.set('pool', pool)
    c.set('userId', user.userId)
    c.set('userEmail', user.userEmail)
    await next()
  })
  app.route('/', health)
  app.route('/api/me', me)
  return app
}
