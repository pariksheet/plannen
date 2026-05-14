import { describe, it, expect } from 'vitest'
import { handle } from './send-reminder.ts'

function mockCtx(handler: (sql: string, params: unknown[]) => any) {
  return {
    db: { query: async (sql: string, params: unknown[] = []) => handler(sql, params) },
    userId: 'cron',
  }
}

describe('send-reminder handler', () => {
  it('returns 204 on OPTIONS', async () => {
    const req = new Request('http://x/', { method: 'OPTIONS' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(204)
  })

  it('returns no-deadlines message when query empty', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(req, mockCtx(() => ({ rows: [], rowCount: 0 })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatch(/No events/)
  })

  it('processes events with creator email', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(
      req,
      mockCtx(() => ({
        rows: [
          {
            id: 'e1',
            title: 'Hike',
            enrollment_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            creator_email: 'alice@example.com',
            creator_full_name: 'Alice',
          },
          {
            id: 'e2',
            title: 'No creator',
            enrollment_deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            creator_email: null,
            creator_full_name: null,
          },
        ],
        rowCount: 2,
      })),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].email).toBe('alice@example.com')
    expect(body.message).toBe('Processed 1 reminders')
  })

  it('returns 400 when db throws', async () => {
    const req = new Request('http://x/', { method: 'POST' })
    const res = await handle(
      req,
      mockCtx(() => {
        throw new Error('boom')
      }),
    )
    expect(res.status).toBe(400)
  })
})
