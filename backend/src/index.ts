import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { health } from './health.js'
import type { AppVariables } from './types.js'

const PORT = Number(process.env.PLANNEN_BACKEND_PORT ?? 54323)
const HOST = '127.0.0.1'

const app = new Hono<{ Variables: AppVariables }>()
app.route('/', health)

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`backend listening on http://${info.address}:${info.port}`)
})

const shutdown = () => {
  console.log('shutting down')
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
