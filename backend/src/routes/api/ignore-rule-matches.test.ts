import { describe, it, expect, beforeAll } from 'vitest'
import { pool } from '../../db.js'

async function match(kind: string, pattern: string, subject: string | null, from: string, emailSubject: string | null): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT plannen.ignore_rule_matches($1, $2, $3, $4, $5) AS m',
    [kind, pattern, subject, from, emailSubject],
  )
  return rows[0].m === true
}

describe('plannen.ignore_rule_matches', () => {
  beforeAll(async () => {
    // Sanity: function exists.
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'plannen' AND p.proname = 'ignore_rule_matches'`,
    )
    expect(rows.length).toBeGreaterThan(0)
  })

  describe('kind=sender', () => {
    it('matches exact lowercase address', async () => {
      expect(await match('sender', 'a@b.com', null, 'a@b.com', 'x')).toBe(true)
    })
    it('is case-insensitive on both sides', async () => {
      expect(await match('sender', 'A@B.COM', null, 'a@b.com', 'x')).toBe(true)
      expect(await match('sender', 'a@b.com', null, 'A@B.COM', 'x')).toBe(true)
    })
    it('strips "Name <addr>" wrapping', async () => {
      expect(await match('sender', 'a@b.com', null, 'Alice <a@b.com>', 'x')).toBe(true)
    })
    it('does not match different addresses', async () => {
      expect(await match('sender', 'a@b.com', null, 'c@b.com', 'x')).toBe(false)
    })
  })

  describe('kind=domain', () => {
    it('matches exact domain', async () => {
      expect(await match('domain', 'acmelife.com', null, 'n@acmelife.com', 'x')).toBe(true)
    })
    it('matches subdomain', async () => {
      expect(await match('domain', 'acmelife.com', null, 'n@e.acmelife.com', 'x')).toBe(true)
      expect(await match('domain', 'acmelife.com', null, 'n@deep.e.acmelife.com', 'x')).toBe(true)
    })
    it('does not match a different domain', async () => {
      expect(await match('domain', 'acmelife.com', null, 'n@acmebank.com', 'x')).toBe(false)
    })
    it('does not match a domain that merely contains the pattern as substring', async () => {
      expect(await match('domain', 'acme.com', null, 'n@acmebank.com', 'x')).toBe(false)
    })
  })

  describe('kind=domain_subject', () => {
    it('matches when both domain and subject substring match', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@e.acmelife.com', 'Policy Renewal Reminder')).toBe(true)
    })
    it('subject substring is case-insensitive', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'RENEWAL', 'n@acmelife.com', 'your policy renewal')).toBe(true)
    })
    it('domain ok but subject misses', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@acmelife.com', 'KYC reminder')).toBe(false)
    })
    it('subject ok but domain misses', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@otherbank.com', 'Policy renewal')).toBe(false)
    })
    it('null email subject does not match', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@acmelife.com', null)).toBe(false)
    })
  })

  it('unknown kind returns false', async () => {
    expect(await match('regex', 'anything', null, 'a@b.com', 'x')).toBe(false)
  })
})
