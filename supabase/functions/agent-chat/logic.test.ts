import { describe, it, expect } from 'vitest'
import {
  decideConfirm,
  isCancel,
  isWriteTool,
  isLookupTool,
  usageDateFor,
  nextMidnightIso,
  proposalSummary,
  executionReceipt,
  buildSystemPrompt,
  isValidTimeZone,
  localNowIso,
  toAbsoluteIso,
  rewriteDateArgs,
  DECLINE_MESSAGE,
} from './logic.ts'
import { getUsage, incrementUsage, type Queryable } from './quota.ts'

describe('tool sets', () => {
  it('classifies write vs lookup tools', () => {
    expect(isWriteTool('create_event')).toBe(true)
    expect(isWriteTool('update_event')).toBe(true)
    expect(isWriteTool('list_events')).toBe(false)
    expect(isLookupTool('get_checklist')).toBe(true)
    expect(isLookupTool('create_event')).toBe(false)
  })
})

describe('decideConfirm', () => {
  it('confirms a cancel even from clear context', () => {
    expect(isCancel('update_event', { id: 'e1', event_status: 'cancelled' })).toBe(true)
    expect(decideConfirm({ tool: 'update_event', args: { id: 'e1', event_status: 'cancelled' }, usedLookup: false })).toBe(true)
  })

  it('confirms any search-resolved action (lookup was used)', () => {
    expect(decideConfirm({ tool: 'check_checklist_item', args: { item_id: 'i1' }, usedLookup: true })).toBe(true)
    expect(decideConfirm({ tool: 'update_event', args: { id: 'e1', title: 'x' }, usedLookup: true })).toBe(true)
  })

  it('executes clear-context creates/edits/ticks directly', () => {
    expect(decideConfirm({ tool: 'create_event', args: { title: 'Swim' }, usedLookup: false })).toBe(false)
    expect(decideConfirm({ tool: 'update_event', args: { id: 'e1', title: 'x' }, usedLookup: false })).toBe(false)
    expect(decideConfirm({ tool: 'check_checklist_item', args: { item_id: 'i1' }, usedLookup: false })).toBe(false)
    expect(decideConfirm({ tool: 'log_activity', args: { activity: 'run' }, usedLookup: false })).toBe(false)
  })
})

describe('timezone day boundaries', () => {
  it('computes the local usage date, not the UTC date', () => {
    // 2026-06-30T23:30:00Z is already 2026-07-01 in Brussels (UTC+2 summer).
    const d = new Date('2026-06-30T23:30:00Z')
    expect(usageDateFor(d, 'Europe/Brussels')).toBe('2026-07-01')
    expect(usageDateFor(d, 'UTC')).toBe('2026-06-30')
  })

  it('next midnight is the next local midnight as a UTC instant', () => {
    const d = new Date('2026-06-30T09:00:00Z') // 11:00 Brussels
    const iso = nextMidnightIso(d, 'Europe/Brussels')
    // Next Brussels midnight = 2026-07-01T00:00 +02:00 = 2026-06-30T22:00Z
    expect(iso).toBe('2026-06-30T22:00:00.000Z')
  })

  it('UTC next midnight', () => {
    const d = new Date('2026-06-30T09:00:00Z')
    expect(nextMidnightIso(d, 'UTC')).toBe('2026-07-01T00:00:00.000Z')
  })
})

describe('proposalSummary', () => {
  it('summarises a cancel with the resolved label', () => {
    expect(proposalSummary('update_event', { id: 'e1', event_status: 'cancelled' }, 'Swimming')).toBe('Cancel “Swimming”?')
  })
  it('summarises an edit', () => {
    expect(proposalSummary('update_event', { id: 'e1', start_date: 'x' }, 'Dentist')).toBe('Update “Dentist”?')
  })
  it('summarises a checklist tick', () => {
    expect(proposalSummary('check_checklist_item', { item_id: 'i1' }, 'Sunscreen')).toBe('Check “Sunscreen”?')
  })
})

describe('executionReceipt', () => {
  it('create receipt includes the title', () => {
    const r = executionReceipt('create_event', { title: 'Swim' }, { title: 'Swim', start_date: '2026-07-03T16:00:00Z' }, 'UTC')
    expect(r).toContain('✓ Created “Swim”')
  })
  it('cancel receipt', () => {
    const r = executionReceipt('update_event', { id: 'e1', event_status: 'cancelled' }, { title: 'Dentist' }, 'UTC')
    expect(r).toBe('✓ Cancelled “Dentist”')
  })
  it('add items counts the rows', () => {
    const r = executionReceipt('add_checklist_items', { checklist_id: 'c1', items: ['a', 'b'] }, [{ id: '1' }, { id: '2' }], 'UTC')
    expect(r).toBe('✓ Added 2 items')
  })
  it('check receipt uses item text', () => {
    expect(executionReceipt('check_checklist_item', { item_id: 'i1' }, { text: 'Passport' }, 'UTC')).toBe('✓ Checked “Passport”')
  })
  it('log activity receipt', () => {
    expect(executionReceipt('log_activity', { activity: 'run' }, { activity: 'run' }, 'UTC')).toBe('✓ Logged “run”')
  })
})

describe('device-timezone interpretation (traveling user)', () => {
  it('validates IANA timezones', () => {
    expect(isValidTimeZone('America/Toronto')).toBe(true)
    expect(isValidTimeZone('Europe/Brussels')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
  })

  it('localNowIso renders the wall clock in the given tz', () => {
    const d = new Date('2026-06-30T16:00:00Z') // 12:00 in Toronto (EDT -4)
    expect(localNowIso(d, 'America/Toronto')).toBe('2026-06-30T12:00:00')
    expect(localNowIso(d, 'Europe/Brussels')).toBe('2026-06-30T18:00:00') // +2
  })

  it('toAbsoluteIso reads a naive wall time as local in tz → absolute UTC', () => {
    // The crux of the traveling bug: "12:00 today" in Ontario must NOT become
    // noon Brussels.
    expect(toAbsoluteIso('2026-06-30T12:00:00', 'America/Toronto')).toBe('2026-06-30T16:00:00.000Z')
    expect(toAbsoluteIso('2026-06-30T12:00:00', 'Europe/Brussels')).toBe('2026-06-30T10:00:00.000Z')
    expect(toAbsoluteIso('2026-06-30T12:00', 'America/Toronto')).toBe('2026-06-30T16:00:00.000Z') // no seconds
  })

  it('toAbsoluteIso passes through already-absolute or date-only values', () => {
    expect(toAbsoluteIso('2026-06-30T16:00:00.000Z', 'America/Toronto')).toBe('2026-06-30T16:00:00.000Z')
    expect(toAbsoluteIso('2026-06-30T12:00:00-04:00', 'Europe/Brussels')).toBe('2026-06-30T12:00:00-04:00')
    expect(toAbsoluteIso('2026-06-30', 'America/Toronto')).toBe('2026-06-30') // all-day → handler's job
  })

  it('rewriteDateArgs converts only the date fields of date-bearing tools', () => {
    expect(rewriteDateArgs('create_event', { title: 'Swim', start_date: '2026-07-03T16:00:00' }, 'America/Toronto'))
      .toEqual({ title: 'Swim', start_date: '2026-07-03T20:00:00.000Z' })
    expect(rewriteDateArgs('update_event', { id: 'e1', start_date: '2026-07-03T16:00:00', end_date: '2026-07-03T17:00:00' }, 'America/Toronto'))
      .toEqual({ id: 'e1', start_date: '2026-07-03T20:00:00.000Z', end_date: '2026-07-03T21:00:00.000Z' })
    expect(rewriteDateArgs('log_activity', { activity: 'run', occurred_at: '2026-06-30T08:00:00' }, 'America/Toronto'))
      .toEqual({ activity: 'run', occurred_at: '2026-06-30T12:00:00.000Z' })
  })

  it('rewriteDateArgs leaves tools without date fields untouched', () => {
    const a = { item_id: 'i1' }
    expect(rewriteDateArgs('check_checklist_item', a, 'America/Toronto')).toBe(a)
  })

  it('rewriteDateArgs is idempotent on already-absolute values', () => {
    const once = rewriteDateArgs('create_event', { title: 'x', start_date: '2026-07-03T16:00:00' }, 'America/Toronto')
    const twice = rewriteDateArgs('create_event', once, 'America/Toronto')
    expect(twice).toEqual(once)
  })
})

describe('buildSystemPrompt', () => {
  it('embeds the decline line, datetime, and context ids', () => {
    const p = buildSystemPrompt({
      nowIso: '2026-06-30T09:00:00.000Z',
      tz: 'Europe/Brussels',
      context: { open_event_id: 'evt-1' },
    })
    expect(p).toContain(DECLINE_MESSAGE)
    expect(p).toContain('2026-06-30T09:00:00.000Z')
    expect(p).toContain('open_event_id: evt-1')
  })
})

// ── quota.ts against a fake pg client ──────────────────────────────────────────

function fakeClient(initial: Record<string, number> = {}): Queryable & { store: Record<string, number> } {
  const store = { ...initial }
  return {
    store,
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('SELECT request_count')) {
        const key = `${params[0]}|${params[1]}`
        return { rows: key in store ? [{ request_count: store[key] }] : [] }
      }
      if (sql.includes('INSERT INTO plannen.agent_usage')) {
        const key = `${params[0]}|${params[1]}`
        store[key] = (store[key] ?? 0) + 1
        return { rows: [{ request_count: store[key] }] }
      }
      return { rows: [] }
    },
  }
}

describe('quota', () => {
  it('getUsage returns 0 when no row exists', async () => {
    const c = fakeClient()
    expect(await getUsage(c, 'u1', '2026-06-30')).toBe(0)
  })
  it('incrementUsage accumulates per (user, date)', async () => {
    const c = fakeClient()
    expect(await incrementUsage(c, 'u1', '2026-06-30')).toBe(1)
    expect(await incrementUsage(c, 'u1', '2026-06-30')).toBe(2)
    expect(await getUsage(c, 'u1', '2026-06-30')).toBe(2)
    // different day is independent
    expect(await incrementUsage(c, 'u1', '2026-07-01')).toBe(1)
  })
})
