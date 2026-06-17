import { describe, it, expect } from 'vitest'
import { sharesModule } from './shares.ts'

function recordingCtx(rowsFor: (sql: string) => unknown[] = () => []) {
  const queries: { sql: string; params: unknown[] }[] = []
  const ctx = {
    client: {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params })
        return { rows: rowsFor(sql), rowCount: rowsFor(sql).length }
      },
    } as any,
    userId: 'u1',
  }
  return { ctx, queries }
}

describe('shares module', () => {
  it('registers exactly 6 tool definitions', () => {
    expect(sharesModule.definitions).toHaveLength(6)
  })

  it('definitions cover the expected tool names', () => {
    const names = sharesModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual([
      'adopt_shared_event', 'assign_todo', 'complete_event',
      'share_event', 'unadopt_shared_event', 'unshare_event',
    ])
  })

  it('every definition name has a matching dispatch entry', () => {
    for (const def of sharesModule.definitions) {
      expect(typeof sharesModule.dispatch[def.name]).toBe('function')
    }
  })

  it('share_event inserts an event_shares row at awareness level for an owned event', async () => {
    const { ctx, queries } = recordingCtx((sql) =>
      /SELECT event_kind/i.test(sql) ? [{ event_kind: 'event' }] : [])
    const res = await sharesModule.dispatch.share_event(
      { event_id: 'e1', targets: [{ type: 'group', id: 'g1' }] }, ctx)
    expect(res).toEqual({ shared: 1 })
    const insert = queries.find((q) => /INSERT INTO plannen\.event_shares/i.test(q.sql))
    expect(insert).toBeTruthy()
    expect(insert!.params).toContain('awareness')
    expect(insert!.params).toContain('group')
  })

  it('share_event rejects an event the caller does not own', async () => {
    const { ctx } = recordingCtx(() => []) // owner SELECT returns no row
    await expect(
      sharesModule.dispatch.share_event({ event_id: 'e1', targets: [{ type: 'all' }] }, ctx),
    ).rejects.toThrow(/owner/i)
  })

  it('assign_todo writes assigned-level rows and requires a todo', async () => {
    const { ctx, queries } = recordingCtx((sql) =>
      /SELECT event_kind/i.test(sql) ? [{ event_kind: 'todo' }] : [])
    const res = await sharesModule.dispatch.assign_todo(
      { todo_id: 't1', targets: [{ type: 'user', id: 'u2' }] }, ctx)
    expect(res).toEqual({ assigned: 1 })
    const insert = queries.find((q) => /INSERT INTO plannen\.event_shares/i.test(q.sql))
    expect(insert!.params).toContain('assigned')
  })

  it('assign_todo rejects a non-todo event', async () => {
    const { ctx } = recordingCtx((sql) =>
      /SELECT event_kind/i.test(sql) ? [{ event_kind: 'event' }] : [])
    await expect(
      sharesModule.dispatch.assign_todo({ todo_id: 'e1', targets: [{ type: 'user', id: 'u2' }] }, ctx),
    ).rejects.toThrow(/todo/i)
  })

  it('assign_todo drops "all" targets and rejects when none remain', async () => {
    const { ctx } = recordingCtx((sql) => /SELECT event_kind/i.test(sql) ? [{ event_kind: 'todo' }] : [])
    await expect(
      sharesModule.dispatch.assign_todo({ todo_id: 't1', targets: [{ type: 'all' }] }, ctx),
    ).rejects.toThrow(/at least one/i)
  })

  it('adopt_shared_event inserts an adoption row when the event is visible', async () => {
    const { ctx, queries } = recordingCtx((sql) =>
      /FROM plannen\.events e\s+WHERE e\.id/i.test(sql) ? [{ one: 1 }] : [])
    const res = await sharesModule.dispatch.adopt_shared_event({ event_id: 'e1' }, ctx)
    expect(res).toEqual({ adopted: true })
    expect(queries.some((q) => /INSERT INTO plannen\.event_share_adoption/i.test(q.sql))).toBe(true)
  })

  it('complete_event calls the complete_event RPC', async () => {
    const { ctx, queries } = recordingCtx(() => [{ id: 'e1', completed_at: '2026-06-17T00:00:00Z' }])
    const res = await sharesModule.dispatch.complete_event({ event_id: 'e1' }, ctx) as { id: string }
    expect(res.id).toBe('e1')
    expect(queries[0].sql).toMatch(/plannen\.complete_event/i)
    expect(queries[0].params).toEqual(['e1', true])
  })

  it('unshare_event for type "all" matches the NULL target row', async () => {
    const { ctx, queries } = recordingCtx((sql) => /SELECT 1 FROM plannen\.events/i.test(sql) ? [{ one: 1 }] : [])
    await sharesModule.dispatch.unshare_event({ event_id: 'e1', target_type: 'all' }, ctx)
    const del = queries.find((q) => /DELETE FROM plannen\.event_shares/i.test(q.sql))
    expect(del!.sql).toMatch(/target_id IS NULL/i)
  })
})
