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

describe('todo completion visibility (fix batch 2026-10)', () => {
  function recordingCtx(rowsFor: (sql: string) => unknown[] = () => []) {
    const queries: { sql: string; params: unknown[] }[] = []
    const ctx = {
      client: {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          return { rows: rowsFor(sql), rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    return { ctx, queries }
  }

  it('list_events selects completed_at so callers can tell done from open', async () => {
    const { ctx, queries } = recordingCtx()
    await eventsModule.dispatch.list_events({}, ctx)
    const list = queries.find((q) => /FROM plannen\.events/i.test(q.sql))!
    expect(list.sql).toMatch(/completed_at/)
  })

  it('list_events completed:false filters to open todos (completed_at IS NULL)', async () => {
    const { ctx, queries } = recordingCtx()
    await eventsModule.dispatch.list_events({ completed: false }, ctx)
    const list = queries.find((q) => /FROM plannen\.events/i.test(q.sql))!
    expect(list.sql).toMatch(/completed_at IS NULL/i)
  })

  it('list_events completed:true filters to done todos (completed_at IS NOT NULL)', async () => {
    const { ctx, queries } = recordingCtx()
    await eventsModule.dispatch.list_events({ completed: true }, ctx)
    const list = queries.find((q) => /FROM plannen\.events/i.test(q.sql))!
    expect(list.sql).toMatch(/completed_at IS NOT NULL/i)
  })

  it('list_events without completed filter does not constrain completed_at', async () => {
    const { ctx, queries } = recordingCtx()
    await eventsModule.dispatch.list_events({}, ctx)
    const list = queries.find((q) => /FROM plannen\.events/i.test(q.sql))!
    expect(list.sql).not.toMatch(/completed_at IS/i)
  })

  it('list_events schema documents the completed filter', () => {
    const def = eventsModule.definitions.find((d) => d.name === 'list_events')!
    expect(def.inputSchema.properties).toHaveProperty('completed')
  })

  it('complete_todo preserves an existing completed_at instead of overwriting it', async () => {
    const { ctx, queries } = recordingCtx((sql) =>
      /UPDATE plannen\.events/i.test(sql) ? [{ id: 't1', event_kind: 'todo', completed_at: '2026-06-01T00:00:00Z' }] : [],
    )
    await eventsModule.dispatch.complete_todo({ id: 't1' }, ctx)
    const upd = queries.find((q) => /UPDATE plannen\.events/i.test(q.sql))!
    expect(upd.sql).toMatch(/COALESCE\(completed_at,\s*\$1\)/i)
  })
})

describe('todo status never encodes completion (fix batch 2026-10)', () => {
  function insertCtx() {
    const inserts: unknown[][] = []
    const ctx = {
      client: {
        query: async (sql: string, params: unknown[] = []) => {
          if (/INSERT INTO plannen\.events/i.test(sql)) {
            inserts.push(params)
            return { rows: [{ id: 'e1', title: 't', start_date: '2026-06-01T10:00:00Z', event_kind: 'todo', event_status: params[6] ?? null }], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    return { ctx, inserts }
  }

  it('create_event: a todo with a start_date in the past is still "going", not "past"', async () => {
    const { ctx, inserts } = insertCtx()
    await eventsModule.dispatch.create_event({ title: 'Pay bill', start_date: '2020-01-01T10:00:00Z', event_kind: 'todo' }, ctx)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).not.toContain('past')
    expect(inserts[0]).toContain('going')
  })

  it('create_event: a plain event with a start_date in the past still derives "past"', async () => {
    const { ctx, inserts } = insertCtx()
    await eventsModule.dispatch.create_event({ title: 'Old show', start_date: '2020-01-01T10:00:00Z' }, ctx)
    expect(inserts[0]).toContain('past')
  })

  it('update_event: refuses to write "past" onto a todo (coerces to going)', async () => {
    const updates: { sql: string; params: unknown[] }[] = []
    const ctx = {
      client: {
        query: async (sql: string, params: unknown[] = []) => {
          if (/SELECT event_kind FROM plannen\.events/i.test(sql)) return { rows: [{ event_kind: 'todo' }], rowCount: 1 }
          if (/UPDATE plannen\.events/i.test(sql)) { updates.push({ sql, params }); return { rows: [{ id: 't1', event_kind: 'todo' }], rowCount: 1 } }
          return { rows: [], rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    await eventsModule.dispatch.update_event({ id: 't1', event_status: 'past' }, ctx)
    expect(updates).toHaveLength(1)
    expect(updates[0].params).not.toContain('past')
    expect(updates[0].params).toContain('going')
  })
})
