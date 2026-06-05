import { describe, it, expect } from 'vitest'
import { provenanceModule } from './provenance.ts'

function stubCtx(rowsToReturn: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    ctx: {
      userId: 'u1',
      client: {
        query: async (sql: string, params: unknown[]) => {
          calls.push({ sql, params })
          return { rows: rowsToReturn, rowCount: rowsToReturn.length }
        },
      },
    },
    calls,
  }
}

describe('provenanceModule', () => {
  it('registers two tools', () => {
    const names = provenanceModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['add_event_provenance', 'get_event_provenance'])
  })
  it('dispatch covers every definition', () => {
    for (const def of provenanceModule.definitions) {
      expect(typeof provenanceModule.dispatch[def.name]).toBe('function')
    }
  })
})

describe('add_event_provenance', () => {
  it('rejects missing event_id', async () => {
    const { ctx } = stubCtx()
    await expect(provenanceModule.dispatch.add_event_provenance({ source: 'mailbox' }, ctx as never))
      .rejects.toThrow(/event_id required/)
  })
  it('rejects missing source', async () => {
    const { ctx } = stubCtx()
    await expect(provenanceModule.dispatch.add_event_provenance({ event_id: 'e1' }, ctx as never))
      .rejects.toThrow(/source required/)
  })
  it('passes all eight fields into the upsert in correct order', async () => {
    const { ctx, calls } = stubCtx([{ event_id: 'e1' }])
    await provenanceModule.dispatch.add_event_provenance({
      event_id: 'e1', source: 'mailbox', adapter_id: 'gmail',
      source_message_id: 't1', sender_display: 'N <a@b.com>',
      sender_email: 'a@b.com', sender_domain: 'b.com', subject: 'hi',
    }, ctx as never)
    expect(calls[0].params).toEqual(['e1', 'mailbox', 'gmail', 't1', 'N <a@b.com>', 'a@b.com', 'b.com', 'hi'])
  })
  it('null-fills optional fields', async () => {
    const { ctx, calls } = stubCtx([{ event_id: 'e1' }])
    await provenanceModule.dispatch.add_event_provenance({ event_id: 'e1', source: 'mailbox' }, ctx as never)
    expect(calls[0].params).toEqual(['e1', 'mailbox', null, null, null, null, null, null])
  })
})

describe('get_event_provenance', () => {
  it('rejects missing event_id', async () => {
    const { ctx } = stubCtx()
    await expect(provenanceModule.dispatch.get_event_provenance({}, ctx as never))
      .rejects.toThrow(/event_id required/)
  })
  it('returns null when no row matches', async () => {
    const { ctx } = stubCtx([])
    const result = await provenanceModule.dispatch.get_event_provenance({ event_id: 'e1' }, ctx as never)
    expect(result).toBeNull()
  })
  it('returns the first row from the join query', async () => {
    const row = { event_id: 'e1', source: 'mailbox' }
    const { ctx } = stubCtx([row])
    const result = await provenanceModule.dispatch.get_event_provenance({ event_id: 'e1' }, ctx as never)
    expect(result).toEqual(row)
  })
  it('joins on created_by = ctx.userId for visibility scoping', async () => {
    const { ctx, calls } = stubCtx([])
    await provenanceModule.dispatch.get_event_provenance({ event_id: 'e1' }, ctx as never)
    expect(calls[0].sql).toMatch(/JOIN plannen\.events e ON e\.id = p\.event_id/)
    expect(calls[0].sql).toMatch(/e\.created_by = \$2/)
    expect(calls[0].params).toEqual(['e1', 'u1'])
  })
})
