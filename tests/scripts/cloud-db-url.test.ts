import { describe, it, expect } from 'vitest'
// @ts-ignore — .mjs module
import { buildPoolerUrl } from '../../scripts/lib/cloud-db-url.mjs'

describe('buildPoolerUrl', () => {
  it('formats the standard pooler URL for eu-central-1', () => {
    const u = buildPoolerUrl({ projectRef: 'abcd1234', region: 'eu-central-1', password: 'hunter2' })
    expect(u).toBe('postgresql://postgres.abcd1234:hunter2@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')
  })

  it('percent-encodes special characters in the password', () => {
    const u = buildPoolerUrl({ projectRef: 'ref', region: 'us-east-1', password: 'p@ss:w/d#' })
    expect(u).toContain('postgres.ref:p%40ss%3Aw%2Fd%23@')
  })

  it('throws on missing fields', () => {
    expect(() => buildPoolerUrl({ projectRef: '', region: 'eu-central-1', password: 'x' })).toThrow(/projectRef/)
    expect(() => buildPoolerUrl({ projectRef: 'r', region: '', password: 'x' })).toThrow(/region/)
    expect(() => buildPoolerUrl({ projectRef: 'r', region: 'eu-central-1', password: '' })).toThrow(/password/)
  })
})
