import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { pool } from '../../db.js'
import { buildApp } from '../../testApp.js'
import { ensureTestUser, deleteTestUser } from './_testFixtures.js'

let app: ReturnType<typeof buildApp>
let testUserId: string
const testEmail = 'mailbox-ignore-rules-test@plannen.local'

beforeAll(async () => {
  testUserId = await ensureTestUser(pool, testEmail)
  app = buildApp({ userId: testUserId, userEmail: testEmail })
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM plannen.mailbox_ignore_rules WHERE user_id = $1', [testUserId])
  } finally { c.release() }
  await deleteTestUser(pool, testEmail)
})

beforeEach(async () => {
  await pool.query('DELETE FROM plannen.mailbox_ignore_rules WHERE user_id = $1', [testUserId])
})

describe('mailbox-ignore-rules routes', () => {
  it('POST rejects payloads missing kind', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', pattern: 'a@b.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST creates kind=domain rule with lowercased pattern', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', kind: 'domain', pattern: 'AcmeLife.com' }),
    })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { pattern: string; kind: string } }
    expect(data.pattern).toBe('acmelife.com')
    expect(data.kind).toBe('domain')
  })

  it('POST rejects domain_subject without subject_keyword', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', kind: 'domain_subject', pattern: 'acmelife.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST rejects subject_keyword on kind=sender', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', kind: 'sender', pattern: 'a@b.com', subject_keyword: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('GET lists rules with adapter_id filter', async () => {
    await pool.query(
      `INSERT INTO plannen.mailbox_ignore_rules (user_id, adapter_id, kind, pattern)
       VALUES ($1, 'gmail', 'sender', 'a@b.com'),
              ($1, 'imap', 'sender', 'c@d.com')`,
      [testUserId],
    )
    const all = await app.request('/api/mailbox-ignore-rules')
    expect(((await all.json()) as { data: unknown[] }).data).toHaveLength(2)
    const gmailOnly = await app.request('/api/mailbox-ignore-rules?adapter_id=gmail')
    expect(((await gmailOnly.json()) as { data: unknown[] }).data).toHaveLength(1)
  })

  it('DELETE removes a rule by id', async () => {
    const { rows } = await pool.query(
      `INSERT INTO plannen.mailbox_ignore_rules (user_id, adapter_id, kind, pattern)
       VALUES ($1, 'gmail', 'sender', 'a@b.com') RETURNING id`,
      [testUserId],
    )
    const del = await app.request(`/api/mailbox-ignore-rules/${rows[0].id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const { rows: after } = await pool.query('SELECT COUNT(*)::int AS c FROM plannen.mailbox_ignore_rules WHERE user_id = $1', [testUserId])
    expect(after[0].c).toBe(0)
  })

  it('DELETE 404s when id does not exist', async () => {
    const res = await app.request('/api/mailbox-ignore-rules/00000000-0000-0000-0000-000000000000', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('POST /find-matching rejects domain_subject without subject_keyword', async () => {
    const res = await app.request('/api/mailbox-ignore-rules/find-matching', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'domain_subject', pattern: 'x.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /find-matching returns empty when no #mbsync events match', async () => {
    const res = await app.request('/api/mailbox-ignore-rules/find-matching', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'domain', pattern: 'nope.example' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([])
  })
})
