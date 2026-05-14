import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import { pool } from './db.js'
import { resolveUserAtBoot } from './auth.js'
import { errorHandler } from './middleware/error.js'
import { corsMiddleware } from './middleware/cors.js'
import { me } from './routes/api/me.js'
import { eventPhotos } from './routes/storage/eventPhotos.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'
const USER_EMAIL = process.env.PLANNEN_USER_EMAIL
if (!USER_EMAIL) {
  console.error('PLANNEN_USER_EMAIL is required (set by bootstrap.sh)')
  process.exit(1)
}

const user = await resolveUserAtBoot(USER_EMAIL)
console.log(`resolved user: ${user.email} (${user.userId})`)

const app = new Hono<{ Variables: AppVariables }>()

app.onError(errorHandler)
app.use('*', corsMiddleware)
app.use('*', async (c, next) => {
  c.set('pool', pool)
  c.set('userId', user.userId)
  c.set('userEmail', user.email)
  await next()
})

app.route('/', health)
app.route('/api/me', me)
app.route('/storage/v1/object', eventPhotos)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`)
})

const shutdown = async () => {
  console.log('shutting down')
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
