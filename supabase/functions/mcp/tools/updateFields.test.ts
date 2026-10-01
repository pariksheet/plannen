import { describe, it, expect } from 'vitest'
import { eventsModule, UPDATE_EVENT_FIELDS } from './events.ts'
import { practicesModule, UPDATE_PRACTICE_FIELDS } from './practices.ts'
import { schedulingModule, UPDATE_ATTENDANCE_FIELDS, UPDATE_OBLIGATION_FIELDS } from './scheduling.ts'
import type { ToolCtx } from '../types.ts'

const ALLOWLISTS: Record<string, readonly string[]> = {
  update_event: UPDATE_EVENT_FIELDS,
  update_practice: UPDATE_PRACTICE_FIELDS,
  update_attendance: UPDATE_ATTENDANCE_FIELDS,
  update_obligation: UPDATE_OBLIGATION_FIELDS,
}

// Update handlers build `SET <column> = $n` from argument keys, so every key a
// caller sends must be a known, caller-settable column. These tests pin that:
// an unknown key is rejected before any UPDATE reaches the database.

function recordingCtx() {
  const queries: string[] = []
  const ctx = {
    client: {
      query: async (sql: string) => {
        queries.push(sql)
        return { rows: [{ id: 'row-1', title: 't', name: 'n' }], rowCount: 1 }
      },
    },
    userId: 'user-1',
  } as unknown as ToolCtx
  return { ctx, updates: () => queries.filter((q) => /^\s*UPDATE/i.test(q)) }
}

const CASES = [
  { tool: 'update_event', mod: eventsModule, valid: { title: 'Weekly call' } },
  { tool: 'update_practice', mod: practicesModule, valid: { name: 'Stretch' } },
  { tool: 'update_attendance', mod: schedulingModule, valid: { name: 'School' } },
  { tool: 'update_obligation', mod: schedulingModule, valid: { offset_minutes: -10 } },
] as const

describe.each(CASES)('$tool column allowlist', ({ tool, mod, valid }) => {
  it('rejects a key that is not a column name', async () => {
    const { ctx, updates } = recordingCtx()
    await expect(
      mod.dispatch[tool]({ id: 'row-1', "title = 'x' --": 'v' }, ctx),
    ).rejects.toThrow(/unknown field/)
    expect(updates()).toHaveLength(0)
  })

  it('rejects ownership columns', async () => {
    const { ctx, updates } = recordingCtx()
    await expect(
      mod.dispatch[tool]({ id: 'row-1', created_by: 'user-2', user_id: 'user-2' }, ctx),
    ).rejects.toThrow(/unknown field/)
    expect(updates()).toHaveLength(0)
  })

  it('still updates an allowed field', async () => {
    const { ctx, updates } = recordingCtx()
    await mod.dispatch[tool]({ id: 'row-1', ...valid }, ctx)
    expect(updates()).toHaveLength(1)
  })

  it('allowlist matches the advertised input schema', () => {
    const def = mod.definitions.find((d) => d.name === tool)!
    const props = Object.keys((def.inputSchema as { properties: Record<string, unknown> }).properties)
      .filter((k) => k !== 'id')
      .sort()
    expect([...ALLOWLISTS[tool]].sort()).toEqual(props)
  })
})
