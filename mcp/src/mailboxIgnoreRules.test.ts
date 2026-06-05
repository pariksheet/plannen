import { describe, it, expect } from 'vitest'
import { normaliseSender, ruleMatches, type IgnoreRule } from './mailboxIgnoreRules.js'

describe('normaliseSender', () => {
  it('lowercases the address', () => {
    expect(normaliseSender('Noreply@Arenal.BE')).toBe('noreply@arenal.be')
  })
  it('strips display-name wrapping', () => {
    expect(normaliseSender('"Arenal" <noreply@arenal.be>')).toBe('noreply@arenal.be')
  })
  it('returns the raw input if no email is detectable', () => {
    expect(normaliseSender('weird-thing')).toBe('weird-thing')
  })
})

describe('ruleMatches', () => {
  const rule: IgnoreRule = {
    id: 'r1', user_id: 'u1', adapter_id: 'gmail',
    sender: 'noreply@arenal.be',
    source_event_id: null, source_message_id: null, reason: null,
    hit_count: 0, last_hit_at: null, created_at: '2026-05-22T00:00:00Z',
  }
  it('matches identical sender + adapter', () => {
    expect(ruleMatches(rule, { adapter_id: 'gmail', sender: 'noreply@arenal.be' })).toBe(true)
  })
  it('matches case-insensitively', () => {
    expect(ruleMatches(rule, { adapter_id: 'gmail', sender: 'NoReply@Arenal.be' })).toBe(true)
  })
  it('does not match different adapter', () => {
    expect(ruleMatches(rule, { adapter_id: 'icloud', sender: 'noreply@arenal.be' })).toBe(false)
  })
  it('does not match different sender', () => {
    expect(ruleMatches(rule, { adapter_id: 'gmail', sender: 'other@arenal.be' })).toBe(false)
  })
})
