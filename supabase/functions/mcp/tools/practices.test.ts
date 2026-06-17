import { describe, it, expect } from 'vitest'
import { practicesModule } from './practices.ts'

describe('practices module', () => {
  it('registers 6 definitions', () => { expect(practicesModule.definitions).toHaveLength(6) })
  it('names', () => {
    expect(practicesModule.definitions.map((d) => d.name).sort()).toEqual(
      ['create_practice', 'delete_practice', 'list_practices', 'mark_practice_done', 'unmark_practice_done', 'update_practice']
    )
  })
  it('dispatch matches definitions', () => {
    for (const def of practicesModule.definitions) expect(typeof practicesModule.dispatch[def.name]).toBe('function')
  })
})

function recordingCtx() {
  const queries: { sql: string; params: unknown[] }[] = []
  const ctx = {
    client: {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params })
        return { rows: [{ id: 'p1' }], rowCount: 1 }
      },
    } as any,
    userId: 'u1',
  }
  return { ctx, queries }
}

describe('practices module — precise_time', () => {
  it('create_practice and update_practice schemas expose precise_time', () => {
    const create = practicesModule.definitions.find((d) => d.name === 'create_practice')!
    const update = practicesModule.definitions.find((d) => d.name === 'update_practice')!
    expect((create.inputSchema.properties as any).precise_time).toBeDefined()
    expect((update.inputSchema.properties as any).precise_time).toBeDefined()
  })

  it('create_practice INSERT includes precise_time and passes its value', async () => {
    const { ctx, queries } = recordingCtx()
    await practicesModule.dispatch.create_practice(
      { name: 'Brush', category: 'circle', recurrence_mode: 'pinned', recurrence_rule: { frequency: 'daily' }, precise_time: '20:00' },
      ctx,
    )
    const insert = queries.find((q) => /INSERT INTO plannen\.practices/i.test(q.sql))!
    expect(insert.sql).toMatch(/precise_time/)
    expect(insert.params).toContain('20:00')
  })

  it('list_practices SELECT returns precise_time', async () => {
    const { ctx, queries } = recordingCtx()
    await practicesModule.dispatch.list_practices({}, ctx)
    const select = queries.find((q) => /FROM plannen\.practices/i.test(q.sql))!
    expect(select.sql).toMatch(/precise_time/)
  })
})
