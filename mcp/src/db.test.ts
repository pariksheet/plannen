import { describe, it, expect, afterAll } from 'vitest'
import { pool, withUserContext } from './db.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!TEST_DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for db tests')

describe('withUserContext', () => {
  afterAll(async () => { await pool.end() })

  it('sets app.current_user_id for the duration of the callback', async () => {
    const u = '00000000-0000-0000-0000-000000000001'
    const seen = await withUserContext(u, async (c) => {
      const { rows } = await c.query("SELECT current_setting('app.current_user_id', true) AS v")
      return rows[0].v
    })
    expect(seen).toBe(u)
  })

  it('GUC does not leak to the next checkout', async () => {
    await withUserContext('00000000-0000-0000-0000-000000000001', async () => {})
    const c = await pool.connect()
    try {
      const { rows } = await c.query("SELECT current_setting('app.current_user_id', true) AS v")
      expect(rows[0].v).toBe('')
    } finally { c.release() }
  })

  it('auth.uid() returns the GUC value', async () => {
    const u = '00000000-0000-0000-0000-000000000002'
    const got = await withUserContext(u, async (c) => {
      const { rows } = await c.query('SELECT auth.uid() AS v')
      return rows[0].v
    })
    expect(got).toBe(u)
  })
})
