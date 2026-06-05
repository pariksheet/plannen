import { describe, it, expect } from 'vitest'
import { briefingsModule } from './briefings.ts'

describe('briefings module', () => {
  it('registers 3 definitions', () => { expect(briefingsModule.definitions).toHaveLength(3) })
  it('names', () => {
    expect(briefingsModule.definitions.map((d) => d.name).sort()).toEqual(
      ['get_briefing_context', 'get_daily_briefing', 'save_daily_briefing']
    )
  })
  it('dispatch matches definitions', () => {
    for (const def of briefingsModule.definitions) expect(typeof briefingsModule.dispatch[def.name]).toBe('function')
  })

  it('get_briefing_context excludes cancelled events from every events query', async () => {
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
    await briefingsModule.dispatch.get_briefing_context({ date: '2026-06-04' }, ctx)
    const eventQueries = queries.filter((q) => /FROM plannen\.events/i.test(q.sql))
    expect(eventQueries).toHaveLength(3) // today, tomorrow, recent past
    for (const q of eventQueries) {
      expect(q.sql).toMatch(/event_status\s*<>\s*'cancelled'/i)
    }
  })
})
