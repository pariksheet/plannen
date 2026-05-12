import { describe, expect, it } from 'vitest'
import { STORY_LANGUAGES, isValidLangCode, validateStoryLanguages } from '../../src/utils/storyLanguages'

describe('STORY_LANGUAGES', () => {
  it('contains 12 curated entries with code+label', () => {
    expect(STORY_LANGUAGES.length).toBe(12)
    for (const l of STORY_LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2}$/)
      expect(l.label.length).toBeGreaterThan(0)
    }
  })

  it('starts with English and includes nl, fr, hi, mr', () => {
    expect(STORY_LANGUAGES[0].code).toBe('en')
    const codes = STORY_LANGUAGES.map(l => l.code)
    for (const c of ['nl', 'fr', 'hi', 'mr']) expect(codes).toContain(c)
  })
})

describe('isValidLangCode', () => {
  it('accepts curated codes', () => {
    expect(isValidLangCode('en')).toBe(true)
    expect(isValidLangCode('nl')).toBe(true)
  })
  it('rejects unknown codes and bad shapes', () => {
    expect(isValidLangCode('xx')).toBe(false)
    expect(isValidLangCode('en-US')).toBe(false)
    expect(isValidLangCode('')).toBe(false)
  })
})

describe('validateStoryLanguages', () => {
  it('accepts a 1–3 entry list of valid codes', () => {
    expect(validateStoryLanguages(['en'])).toEqual({ ok: true, value: ['en'] })
    expect(validateStoryLanguages(['en', 'nl', 'fr'])).toEqual({ ok: true, value: ['en', 'nl', 'fr'] })
  })
  it('rejects empty list', () => {
    expect(validateStoryLanguages([])).toEqual({ ok: false, error: 'At least one language is required.' })
  })
  it('rejects more than 3', () => {
    expect(validateStoryLanguages(['en', 'nl', 'fr', 'de'])).toEqual({ ok: false, error: 'Maximum 3 languages.' })
  })
  it('rejects unknown codes', () => {
    expect(validateStoryLanguages(['en', 'xx'])).toEqual({ ok: false, error: 'Unknown language: xx' })
  })
  it('dedupes while preserving order', () => {
    expect(validateStoryLanguages(['en', 'nl', 'en'])).toEqual({ ok: true, value: ['en', 'nl'] })
  })
})
