import { describe, it, expect } from 'vitest'
import { eventsModule } from './events.ts'

describe('events module', () => {
  it('registers exactly 8 tool definitions', () => {
    expect(eventsModule.definitions).toHaveLength(8)
  })

  it('definitions cover the expected tool names', () => {
    const names = eventsModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['complete_todo', 'create_event', 'get_event', 'list_events', 'log_completion', 'rsvp_event', 'uncomplete_todo', 'update_event'])
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

  it('create_event round-trips subject attribution fields', async () => {
    const subjectId = '11111111-1111-4111-8111-111111111111'
    const ctx = {
      client: {
        query: async (sql: string) => {
          // timezone lookup → empty (defaults UTC); INSERT → echo a row.
          if (/INSERT INTO plannen\.events/i.test(sql)) {
            return {
              rows: [{
                id: 'e1',
                title: 'Swim lesson',
                start_date: '2026-06-15T10:00:00Z',
                subject_kind: 'family_member',
                subject_id: subjectId,
                owner_attends: false,
              }],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    const result = await eventsModule.dispatch.create_event(
      {
        title: 'Swim lesson',
        start_date: '2026-06-15T10:00:00Z',
        subject_kind: 'family_member',
        subject_id: subjectId,
        owner_attends: false,
      },
      ctx,
    ) as Record<string, unknown>
    expect(result.subject_kind).toBe('family_member')
    expect(result.subject_id).toBe(subjectId)
    expect(result.owner_attends).toBe(false)
  })
})
