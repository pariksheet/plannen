// RLS regression test for the family-as-group unification (PR #48).
//
// The migration that introduced group-based event sharing rewrote the RLS on
// event_rsvps + event_memories to allow visibility via user_in_event_group /
// user_in_event_shared_with_users, but forgot to add the equivalent SELECT
// policies on the plannen.events table itself. As a result, a recipient
// could see the share-junction rows but not the events they pointed to,
// leaving the MyGroups + MyPeople feeds empty for non-creators.
//
// The seed runs as the connection's default (superuser) role so we can stage
// rows that cross RLS boundaries. The assertion query then SET LOCAL ROLE
// authenticated, the role that PostgREST / supabase-js connect as in Tier
// 1/2, so RLS actually engages.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from './db.js'
import { ensureTestUser, deleteTestUser } from './routes/api/_testFixtures.js'

const creatorEmail = 'share-rls-creator@plannen.local'
const recipientEmail = 'share-rls-recipient@plannen.local'

let creatorId: string
let recipientId: string
let groupId: string
let groupSharedEventId: string
let directSharedEventId: string

async function selectEventAsRecipient(eventId: string): Promise<number> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('SELECT set_config($1, $2, true)', ['app.current_user_id', recipientId])
    await c.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', recipientId])
    await c.query('SET LOCAL ROLE authenticated')
    const { rows } = await c.query('SELECT id FROM plannen.events WHERE id = $1', [eventId])
    await c.query('ROLLBACK')
    return rows.length
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

beforeAll(async () => {
  creatorId = await ensureTestUser(pool, creatorEmail)
  recipientId = await ensureTestUser(pool, recipientEmail)

  const c = await pool.connect()
  try {
    const g = await c.query(
      `INSERT INTO plannen.friend_groups (name, created_by) VALUES ('rls-test-group', $1) RETURNING id`,
      [creatorId],
    )
    groupId = g.rows[0].id

    await c.query(
      `INSERT INTO plannen.friend_group_members (group_id, user_id) VALUES ($1, $2)`,
      [groupId, recipientId],
    )

    const e1 = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('rls-group-shared', now(), $1, 'going') RETURNING id`,
      [creatorId],
    )
    groupSharedEventId = e1.rows[0].id
    await c.query(
      `INSERT INTO plannen.event_shared_with_groups (event_id, group_id) VALUES ($1, $2)`,
      [groupSharedEventId, groupId],
    )

    const e2 = await c.query(
      `INSERT INTO plannen.events (title, start_date, created_by, event_status)
       VALUES ('rls-direct-shared', now(), $1, 'going') RETURNING id`,
      [creatorId],
    )
    directSharedEventId = e2.rows[0].id
    await c.query(
      `INSERT INTO plannen.event_shared_with_users (event_id, user_id) VALUES ($1, $2)`,
      [directSharedEventId, recipientId],
    )
  } finally {
    c.release()
  }
})

afterAll(async () => {
  const c = await pool.connect()
  try {
    const eventIds = [groupSharedEventId, directSharedEventId].filter(Boolean)
    if (eventIds.length > 0) {
      await c.query('DELETE FROM plannen.event_shared_with_users WHERE event_id = ANY($1::uuid[])', [eventIds])
      await c.query('DELETE FROM plannen.event_shared_with_groups WHERE event_id = ANY($1::uuid[])', [eventIds])
      await c.query('DELETE FROM plannen.events WHERE id = ANY($1::uuid[])', [eventIds])
    }
    if (groupId) {
      await c.query('DELETE FROM plannen.friend_group_members WHERE group_id = $1', [groupId])
      await c.query('DELETE FROM plannen.friend_groups WHERE id = $1', [groupId])
    }
  } finally {
    c.release()
  }
  await deleteTestUser(pool, creatorEmail)
  await deleteTestUser(pool, recipientEmail)
})

describe('events RLS — recipients can see events shared with them', () => {
  it('a group member can SELECT an event shared with their group', async () => {
    const visible = await selectEventAsRecipient(groupSharedEventId)
    expect(visible).toBe(1)
  })

  it('a directly-shared user can SELECT the event via event_shared_with_users', async () => {
    const visible = await selectEventAsRecipient(directSharedEventId)
    expect(visible).toBe(1)
  })
})
