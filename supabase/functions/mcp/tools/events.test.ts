import { describe, it, expect } from 'vitest'
import { eventsModule } from './events.ts'

describe('events module', () => {
  it('registers exactly 5 tool definitions', () => {
    expect(eventsModule.definitions).toHaveLength(5)
  })

  it('definitions cover the expected tool names', () => {
    const names = eventsModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['create_event', 'get_event', 'list_events', 'rsvp_event', 'update_event'])
  })

  it('every definition name has a matching dispatch entry', () => {
    for (const def of eventsModule.definitions) {
      expect(typeof eventsModule.dispatch[def.name]).toBe('function')
    }
  })

  it('list_events dispatch executes a parameterised query against ctx.client', async () => {
    const queries: { sql: string; params: unknown[] }[] = []
    const ctx = {
      client: {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          return { rows: [], rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    await eventsModule.dispatch.list_events({}, ctx)
    expect(queries.length).toBeGreaterThan(0)
    const sqlBlob = queries.map((q) => q.sql).join(' ')
    expect(sqlBlob).toMatch(/plannen\.events/i)
  })

  it('create_event rejects missing title', async () => {
    const ctx = { client: { query: async () => ({ rows: [], rowCount: 0 }) } as any, userId: 'u1' }
    await expect(
      eventsModule.dispatch.create_event({ start_date: '2026-06-15T10:00:00Z' }, ctx),
    ).rejects.toThrow(/title/i)
  })
})
