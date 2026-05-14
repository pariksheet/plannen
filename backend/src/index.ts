import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import { pool } from './db.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'

const app = new Hono<{ Variables: AppVariables }>()

app.use('*', async (c, next) => {
  c.set('pool', pool)
  await next()
})

app.route('/', health)

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
