import { Hono } from 'hono'
import type { AppVariables } from './types.js'

export const health = new Hono<{ Variables: AppVariables }>()

health.get('/health', (c) => {
  return c.json({
    status: 'ok',
    tier: process.env.PLANNEN_TIER ?? '0',
    dbConnected: !!c.var.pool,
  })
})
