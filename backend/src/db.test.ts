import { describe, it, expect, afterAll } from 'vitest'
import { pool, withUserContext } from './db.js'

afterAll(async () => {
  await pool.end()
})

describe('withUserContext (backend)', () => {
  it('sets app.current_user_id for the duration of the callback', async () => {
    const u = '00000000-0000-0000-0000-000000000001'
    const seen = await withUserContext(u, async (c) => {
      const { rows } = await c.query(
        "SELECT current_setting('app.current_user_id', true) AS v",
      )
      return rows[0].v
    })
    expect(seen).toBe(u)
  })

  it('does NOT leak GUC to a subsequent checkout', async () => {
    await withUserContext('00000000-0000-0000-0000-000000000001', async () => {})
    const c = await pool.connect()
    try {
      const { rows } = await c.query(
        "SELECT current_setting('app.current_user_id', true) AS v",
      )
      expect(rows[0].v).toBe('')
    } finally {
      c.release()
    }
  })

  it('auth.uid() resolves to the GUC value inside the callback', async () => {
    const u = '00000000-0000-0000-0000-000000000002'
    const got = await withUserContext(u, async (c) => {
      const { rows } = await c.query('SELECT auth.uid() AS v')
      return rows[0].v
    })
    expect(got).toBe(u)
  })
})
