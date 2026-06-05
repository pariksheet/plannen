import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub sendPush so the handler runs without a real web-push setup. The stub
// records every call so we can assert recipients + payload tag.
const sentPushes: Array<{ userId: string; payload: { title: string; body?: string; url?: string; tag?: string } }> = []
vi.mock('./push.ts', () => ({
  sendPush: async (_db: unknown, userId: string, payload: { title: string; body?: string; url?: string; tag?: string }) => {
    sentPushes.push({ userId, payload })
    return { attempted: 1, sent: 1, removed: 0, errors: [] as string[] }
  },
}))

import { handleNotify } from './notify.ts'

type Row = Record<string, unknown>
function mockDb(behavior: (sql: string, params: unknown[]) => Row[] | undefined) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const rows = behavior(sql, params) ?? []
      return { rows, rowCount: rows.length }
    },
  }
}

beforeEach(() => {
  sentPushes.length = 0
})

describe('notify handler', () => {
  it('rejects non-POST', async () => {
    const req = new Request('http://x/', { method: 'GET' })
    const res = await handleNotify(req, { db: mockDb(() => []) as never, userId: 'u-sender' })
    expect(res.status).toBe(405)
  })

  it('returns 400 on invalid body', async () => {
    const req = new Request('http://x/', { method: 'POST', body: 'not-json' })
    const res = await handleNotify(req, { db: mockDb(() => []) as never, userId: 'u-sender' })
    expect(res.status).toBe(400)
  })

  it('returns 400 on unknown kind', async () => {
    const req = new Request('http://x/', { method: 'POST', body: JSON.stringify({ kind: 'pong' }) })
    const res = await handleNotify(req, { db: mockDb(() => []) as never, userId: 'u-sender' })
    expect(res.status).toBe(400)
  })

  describe('rsvp', () => {
    const eventId = '00000000-0000-0000-0000-000000000001'

    it('returns 404 when the event is missing', async () => {
      const db = mockDb((sql) => (sql.includes('FROM plannen.events') ? [] : []))
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'rsvp', event_id: eventId, status: 'going' }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(404)
    })

    it('skips push when sender is the event creator', async () => {
      const db = mockDb((sql) =>
        sql.includes('FROM plannen.events') ? [{ title: 'My party', created_by: 'u-sender' }] : [],
      )
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'rsvp', event_id: eventId, status: 'going' }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.recipients).toBe(0)
      expect(sentPushes).toHaveLength(0)
    })

    it('pushes to creator with proper tag + payload', async () => {
      const db = mockDb((sql) => {
        if (sql.includes('FROM plannen.events')) return [{ title: 'Cool party', created_by: 'u-creator' }]
        if (sql.includes('FROM plannen.users')) return [{ full_name: 'Alex', email: 'alex@example.com' }]
        return []
      })
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'rsvp', event_id: eventId, status: 'going' }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(200)
      expect(sentPushes).toEqual([
        {
          userId: 'u-creator',
          payload: expect.objectContaining({
            title: "Alex RSVP'd going",
            body: 'Cool party',
            url: `/events/${eventId}`,
            tag: `rsvp-${eventId}-u-sender`,
          }),
        },
      ])
    })

    it('falls back to email prefix when full_name is missing', async () => {
      const db = mockDb((sql) => {
        if (sql.includes('FROM plannen.events')) return [{ title: 't', created_by: 'u-creator' }]
        if (sql.includes('FROM plannen.users')) return [{ full_name: null, email: 'alex@example.com' }]
        return []
      })
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'rsvp', event_id: eventId, status: 'maybe' }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(200)
      expect(sentPushes[0].payload.title).toBe("alex RSVP'd maybe")
    })
  })

  describe('event_shared', () => {
    const eventId = '00000000-0000-0000-0000-000000000002'
    const groupId = '00000000-0000-0000-0000-0000000000aa'

    it('rejects non-owner', async () => {
      const db = mockDb((sql) =>
        sql.includes('FROM plannen.events') ? [{ title: 'X', created_by: 'someone-else' }] : [],
      )
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'event_shared', event_id: eventId, group_ids: [groupId] }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(403)
    })

    it('dedupes recipients across groups + user_ids and excludes sender', async () => {
      const db = mockDb((sql) => {
        if (sql.includes('FROM plannen.events')) return [{ title: 'Trip', created_by: 'u-sender' }]
        if (sql.includes('friend_group_members')) {
          return [{ user_id: 'u-a' }, { user_id: 'u-b' }, { user_id: 'u-sender' }]
        }
        if (sql.includes('FROM plannen.users')) return [{ full_name: 'Sam', email: 'sam@x' }]
        return []
      })
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'event_shared',
          event_id: eventId,
          group_ids: [groupId],
          user_ids: ['u-b', '00000000-0000-0000-0000-0000000000cc'],
        }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(200)
      const recipientIds = sentPushes.map((p) => p.userId).sort()
      expect(recipientIds).toEqual(['00000000-0000-0000-0000-0000000000cc', 'u-a', 'u-b'])
      for (const p of sentPushes) {
        expect(p.payload.tag).toBe(`event-new-${eventId}`)
        expect(p.payload.title).toBe('Sam shared an event')
      }
    })
  })

  describe('story_shared', () => {
    const storyId = '00000000-0000-0000-0000-000000000003'

    it('rejects non-owner', async () => {
      const db = mockDb((sql) =>
        sql.includes('FROM plannen.stories') ? [{ title: 'S', user_id: 'someone-else' }] : [],
      )
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'story_shared', story_id: storyId, user_ids: ['00000000-0000-0000-0000-0000000000aa'] }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(403)
    })

    it('uses story title + correct tag', async () => {
      const db = mockDb((sql) => {
        if (sql.includes('FROM plannen.stories')) return [{ title: 'Our weekend', user_id: 'u-sender' }]
        if (sql.includes('FROM plannen.users')) return [{ full_name: 'Sam', email: null }]
        return []
      })
      const req = new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({ kind: 'story_shared', story_id: storyId, user_ids: ['00000000-0000-0000-0000-0000000000aa'] }),
      })
      const res = await handleNotify(req, { db: db as never, userId: 'u-sender' })
      expect(res.status).toBe(200)
      expect(sentPushes[0].userId).toBe('00000000-0000-0000-0000-0000000000aa')
      expect(sentPushes[0].payload.title).toBe('Sam shared a story')
      expect(sentPushes[0].payload.body).toBe('Our weekend')
      expect(sentPushes[0].payload.tag).toBe(`story-${storyId}`)
    })
  })
})
