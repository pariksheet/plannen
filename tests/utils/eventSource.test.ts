import { describe, it, expect } from 'vitest'
import { extractDomain } from '../../src/utils/eventSource'

describe('extractDomain', () => {
  it('extracts hostname from a full URL', () => {
    expect(extractDomain('https://www.esdoornkampen.nl/inschrijven')).toBe('esdoornkampen.nl')
  })

  it('strips www. prefix', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com')
  })

  it('leaves non-www subdomains intact', () => {
    expect(extractDomain('https://events.meetup.com/group')).toBe('events.meetup.com')
  })

  it('returns null for an invalid URL', () => {
    expect(extractDomain('not-a-url')).toBeNull()
  })

  it('returns null for localhost', () => {
    expect(extractDomain('http://localhost:3000')).toBeNull()
  })

  it('returns null for IP addresses', () => {
    expect(extractDomain('http://192.168.1.1/page')).toBeNull()
  })

  it('handles URLs without a path', () => {
    expect(extractDomain('https://eventbrite.com')).toBe('eventbrite.com')
  })
})
