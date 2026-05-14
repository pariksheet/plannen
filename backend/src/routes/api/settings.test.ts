import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'settings-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.user_settings WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

describe('settings routes', () => {
  it('PATCH /api/settings upserts a provider', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', api_key: 'sk-test', default_model: 'claude-opus-4-7' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.provider).toBe('anthropic')
    expect(body.data.api_key).toBeUndefined()
    expect(body.data.has_api_key).toBe(true)
  })

  it('GET /api/settings redacts api_key', async () => {
    const res = await app.request('/api/settings')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.has_api_key).toBe(true)
    expect(body.data.api_key).toBeUndefined()
  })

  it('DELETE /api/settings removes', async () => {
    const res = await app.request('/api/settings?provider=anthropic', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/settings/system', () => {
  it('returns tier and cliAvailable', async () => {
    const res = await app.request('/api/settings/system')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveProperty('tier')
    expect(body.data).toHaveProperty('cliAvailable')
    expect(typeof body.data.tier).toBe('number')
    expect(typeof body.data.cliAvailable).toBe('boolean')
  })
})

describe('PATCH /api/settings — CLI provider validation', () => {
  afterEach(async () => {
    const c = await pool.connect()
    try { await c.query('DELETE FROM plannen.user_settings WHERE user_id = $1', [testUserId]) }
    finally { c.release() }
  })

  it('accepts claude-code-cli with no api_key on tier 0', async () => {
    process.env.PLANNEN_TIER = '0'
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code-cli' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.provider).toBe('claude-code-cli')
    expect(body.data.has_api_key).toBe(false)
  })

  it('rejects claude-code-cli when an api_key is supplied', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code-cli', api_key: 'sk-bogus' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects claude-code-cli on tier 1', async () => {
    process.env.PLANNEN_TIER = '1'
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code-cli' }),
    })
    expect(res.status).toBe(400)
    process.env.PLANNEN_TIER = '0'
  })

  it('rejects anthropic without api_key (unchanged behaviour)', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    })
    expect(res.status).toBe(400)
  })
})
