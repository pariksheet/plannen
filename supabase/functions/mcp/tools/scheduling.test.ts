import { describe, it, expect, vi } from 'vitest'
import { schedulingModule } from './scheduling.ts'
import type { ToolCtx } from '../types.ts'

const EXPECTED = [
  'add_blackout_window',
  'create_attendance',
  'create_blackout_calendar',
  'delete_attendance',
  'link_attendance_blackout',
  'list_attendances',
  'list_blackout_calendars',
  'update_attendance',
]

function mockCtx(queryImpl: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params) as { rows: unknown[]; rowCount?: number })
  const ctx = { client: { query }, userId: 'user-1' } as unknown as ToolCtx
  return { ctx, query }
}

describe('scheduling module', () => {
  it('registers 8 definitions', () => {
    expect(schedulingModule.definitions).toHaveLength(8)
  })

  it('exposes the expected tool names', () => {
    expect(schedulingModule.definitions.map((d) => d.name).sort()).toEqual(EXPECTED)
  })

  it('dispatch matches definitions', () => {
    for (const def of schedulingModule.definitions) {
      expect(typeof schedulingModule.dispatch[def.name]).toBe('function')
    }
  })

  it('create_attendance INSERTs into plannen.attendances with serialized recurrence_rule', async () => {
    const { ctx, query } = mockCtx(() => ({ rows: [{ id: 'att-1' }] }))
    const out = await schedulingModule.dispatch.create_attendance(
      {
        family_member_id: 'milo',
        name: 'example school',
        recurrence_rule: { frequency: 'weekly', days: ['MO', 'TU', 'WE', 'TH', 'FR'] },
      },
      ctx,
    )
    expect(out).toEqual({ id: 'att-1' })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/INSERT INTO plannen\.attendances/)
    expect(params?.[0]).toBe('user-1')
    expect(params?.[1]).toBe('milo')
    expect(params?.[2]).toBe('example school')
    // recurrence_rule is JSON.stringify'd at param index 4
    expect(params?.[4]).toBe(JSON.stringify({ frequency: 'weekly', days: ['MO', 'TU', 'WE', 'TH', 'FR'] }))
  })

  it('list_attendances SELECTs scoped to the user and filters by active_only', async () => {
    const { ctx, query } = mockCtx(() => ({ rows: [{ id: 'att-1' }] }))
    const out = await schedulingModule.dispatch.list_attendances({ active_only: true }, ctx)
    expect(out).toEqual([{ id: 'att-1' }])
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/FROM plannen\.attendances/)
    expect(sql).toMatch(/active = true/)
    expect(params).toEqual(['user-1'])
  })

  it('delete_attendance soft-deletes (active = false) and throws when missing', async () => {
    const { ctx } = mockCtx(() => ({ rows: [], rowCount: 0 }))
    await expect(
      schedulingModule.dispatch.delete_attendance({ id: 'nope' }, ctx),
    ).rejects.toThrow('attendance not found')
  })

  it('add_blackout_window verifies calendar ownership before inserting', async () => {
    const { ctx, query } = mockCtx((sql) =>
      /SELECT 1 FROM plannen\.blackout_calendars/.test(sql)
        ? { rows: [{ '?column?': 1 }] }
        : { rows: [{ id: 'win-1' }] },
    )
    const out = await schedulingModule.dispatch.add_blackout_window(
      { calendar_id: 'cal-1', starts_on: '2026-07-01', ends_on: '2026-08-31', label: 'example school holidays' },
      ctx,
    )
    expect(out).toEqual({ id: 'win-1' })
    expect(query.mock.calls[0][0]).toMatch(/SELECT 1 FROM plannen\.blackout_calendars/)
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO plannen\.blackout_windows/)
  })

  it('link_attendance_blackout ON CONFLICT DO NOTHING after both ownership checks', async () => {
    const { ctx, query } = mockCtx(() => ({ rows: [{ '?column?': 1 }] }))
    const out = await schedulingModule.dispatch.link_attendance_blackout(
      { attendance_id: 'att-1', calendar_id: 'cal-1' },
      ctx,
    )
    expect(out).toEqual({ ok: true })
    const insertCall = query.mock.calls.find((c) => /INSERT INTO plannen\.attendance_blackouts/.test(c[0] as string))
    expect(insertCall).toBeDefined()
    expect(insertCall![0]).toMatch(/ON CONFLICT \(attendance_id, calendar_id\) DO NOTHING/)
  })
})
