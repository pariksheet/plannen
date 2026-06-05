import { describe, it, expect } from 'vitest'
import { mailboxModule, normaliseSender } from './mailbox.ts'

describe('mailbox module', () => {
  it('registers 7 definitions', () => { expect(mailboxModule.definitions).toHaveLength(7) })
  it('names', () => {
    expect(mailboxModule.definitions.map((d) => d.name).sort()).toEqual([
      'add_ignore_rule',
      'bump_ignore_rule_hit',
      'delete_ignore_rule',
      'find_matching_mbsync_events',
      'get_mailbox_sync_state',
      'list_ignore_rules',
      'set_mailbox_sync_state',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of mailboxModule.definitions) expect(typeof mailboxModule.dispatch[def.name]).toBe('function')
  })
})

describe('normaliseSender', () => {
  it('strips display-name wrappers and lowercases', () => {
    expect(normaliseSender('Alice <ALICE@Example.com>')).toBe('alice@example.com')
  })
  it('passes bare addresses through, lowercased', () => {
    expect(normaliseSender('Bob@Example.COM')).toBe('bob@example.com')
  })
})

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

describe('add_ignore_rule validation', () => {
  it('rejects missing kind', async () => {
    const { ctx } = stubCtx()
    await expect(mailboxModule.dispatch.add_ignore_rule({ adapter_id: 'gmail', pattern: 'a@b.com' }, ctx as never))
      .rejects.toThrow(/kind must be one of/)
  })
  it('rejects domain_subject without subject_keyword', async () => {
    const { ctx } = stubCtx()
    await expect(mailboxModule.dispatch.add_ignore_rule({ adapter_id: 'gmail', kind: 'domain_subject', pattern: 'acmelife.com' }, ctx as never))
      .rejects.toThrow(/subject_keyword is required/)
  })
  it('rejects subject_keyword on kind=sender', async () => {
    const { ctx } = stubCtx()
    await expect(mailboxModule.dispatch.add_ignore_rule({ adapter_id: 'gmail', kind: 'sender', pattern: 'a@b.com', subject_keyword: 'x' }, ctx as never))
      .rejects.toThrow(/only allowed when kind=domain_subject/)
  })
  it('lowercases the pattern in the SQL params', async () => {
    const { ctx, calls } = stubCtx([{ id: 'r1', pattern: 'acmelife.com' }])
    await mailboxModule.dispatch.add_ignore_rule({ adapter_id: 'gmail', kind: 'domain', pattern: 'AcmeLife.com' }, ctx as never)
    expect(calls[0].params).toContain('acmelife.com')
  })
  it('passes the kind into the SQL params', async () => {
    const { ctx, calls } = stubCtx([{ id: 'r1' }])
    await mailboxModule.dispatch.add_ignore_rule({ adapter_id: 'gmail', kind: 'sender', pattern: 'a@b.com' }, ctx as never)
    expect(calls[0].params).toContain('sender')
  })
})

describe('find_matching_mbsync_events validation', () => {
  it('rejects missing kind', async () => {
    const { ctx } = stubCtx()
    await expect(mailboxModule.dispatch.find_matching_mbsync_events({ pattern: 'a@b.com' }, ctx as never))
      .rejects.toThrow(/kind must be one of/)
  })
  it('rejects domain_subject without subject_keyword', async () => {
    const { ctx } = stubCtx()
    await expect(mailboxModule.dispatch.find_matching_mbsync_events({ kind: 'domain_subject', pattern: 'x.com' }, ctx as never))
      .rejects.toThrow(/subject_keyword is required/)
  })
  it('passes lowercased pattern and null subject for sender kind', async () => {
    const { ctx, calls } = stubCtx([{ id: 'e1' }])
    await mailboxModule.dispatch.find_matching_mbsync_events({ kind: 'sender', pattern: 'A@B.com' }, ctx as never)
    expect(calls[0].params).toEqual(['sender', 'a@b.com', null])
  })
  it('passes lowercased pattern and trimmed subject for domain_subject kind', async () => {
    const { ctx, calls } = stubCtx([{ id: 'e1' }])
    await mailboxModule.dispatch.find_matching_mbsync_events(
      { kind: 'domain_subject', pattern: 'ACMELife.COM', subject_keyword: '  Renewal  ' },
      ctx as never,
    )
    expect(calls[0].params).toEqual(['domain_subject', 'acmelife.com', 'Renewal'])
  })
  it('rejects subject_keyword on kind=sender', async () => {
    const { ctx } = stubCtx()
    await expect(
      mailboxModule.dispatch.find_matching_mbsync_events(
        { kind: 'sender', pattern: 'a@b.com', subject_keyword: 'x' },
        ctx as never,
      ),
    ).rejects.toThrow(/only allowed when kind=domain_subject/)
  })
})
