import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { pool } from '../db.js'
import { ensureTestUser, deleteTestUser } from '../routes/api/_testFixtures.js'
import { maybeAutoConfigureCliProvider } from './maybeAutoConfigureCliProvider.js'

const email = 'cli-autoconfig-test@plannen.local'
let userId: string

beforeAll(async () => { userId = await ensureTestUser(pool, email) })
afterEach(async () => {
  const c = await pool.connect()
  try { await c.query('DELETE FROM plannen.user_settings WHERE user_id = $1', [userId]) }
  finally { c.release() }
})
afterAll(async () => { await deleteTestUser(pool, email) })

describe('maybeAutoConfigureCliProvider', () => {
  it('inserts a default claude-code-cli row when no settings exist', async () => {
    await maybeAutoConfigureCliProvider(pool, userId, '1.0.0')
    const { rows } = await pool.query(
      'SELECT provider, is_default, api_key FROM plannen.user_settings WHERE user_id = $1',
      [userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'claude-code-cli',
      is_default: true,
      api_key: null,
    })
  })

  it('does NOT overwrite an existing default row', async () => {
    await pool.query(
      `INSERT INTO plannen.user_settings (user_id, provider, is_default, api_key)
       VALUES ($1, 'anthropic', true, 'sk-existing')`,
      [userId],
    )
    await maybeAutoConfigureCliProvider(pool, userId, '1.0.0')
    const { rows } = await pool.query(
      'SELECT provider, api_key FROM plannen.user_settings WHERE user_id = $1',
      [userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'anthropic', api_key: 'sk-existing' })
  })
})
