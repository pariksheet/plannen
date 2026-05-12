import { describe, it, expect } from 'vitest'
import {
  parseSourceUrl,
  normaliseTags,
  validateName,
  validateSourceType,
} from './sources.js'

describe('parseSourceUrl', () => {
  it('extracts domain and strips www.', () => {
    expect(parseSourceUrl('https://www.pauseandplay.be/')).toEqual({
      domain: 'pauseandplay.be',
      sourceUrl: 'https://www.pauseandplay.be/',
    })
  })
  it('preserves non-www host', () => {
    expect(parseSourceUrl('https://app.twizzit.com/foo')).toEqual({
      domain: 'app.twizzit.com',
      sourceUrl: 'https://app.twizzit.com/foo',
    })
  })
  it('throws "invalid url" for non-URL strings', () => {
    expect(() => parseSourceUrl('not a url')).toThrow('invalid url')
  })
  it('throws "invalid url" for non-http protocols', () => {
    expect(() => parseSourceUrl('ftp://example.com')).toThrow('invalid url')
  })
  it('throws "invalid url" for empty string', () => {
    expect(() => parseSourceUrl('')).toThrow('invalid url')
  })
})

describe('normaliseTags', () => {
  it('trims, lowercases, dedupes', () => {
    expect(normaliseTags(['  Kids ', 'kids', 'BRUNCH'])).toEqual(['kids', 'brunch'])
  })
  it('caps at 10', () => {
    const input = Array.from({ length: 15 }, (_, i) => `tag${i}`)
    expect(normaliseTags(input)).toHaveLength(10)
  })
  it('drops empty / whitespace-only entries', () => {
    expect(normaliseTags(['kids', '   ', ''])).toEqual(['kids'])
  })
  it('throws "tags required" for empty array', () => {
    expect(() => normaliseTags([])).toThrow('tags required')
  })
  it('throws "tags required" when all entries are whitespace', () => {
    expect(() => normaliseTags(['  ', ''])).toThrow('tags required')
  })
})

describe('validateName', () => {
  it('returns trimmed name', () => {
    expect(validateName('  Pause & Play  ')).toBe('Pause & Play')
  })
  it('throws "name required" for empty string', () => {
    expect(() => validateName('')).toThrow('name required')
  })
  it('throws "name required" for whitespace-only', () => {
    expect(() => validateName('   ')).toThrow('name required')
  })
})

describe('validateSourceType', () => {
  it('accepts platform, organiser, one_off', () => {
    expect(validateSourceType('platform')).toBe('platform')
    expect(validateSourceType('organiser')).toBe('organiser')
    expect(validateSourceType('one_off')).toBe('one_off')
  })
  it('throws "invalid source_type" for other values', () => {
    expect(() => validateSourceType('venue')).toThrow('invalid source_type')
    expect(() => validateSourceType('')).toThrow('invalid source_type')
  })
})
