import { describe, expect, it } from 'vitest'
import { parseDetectedLanguage, extFromContentType } from './transcribe.js'

describe('parseDetectedLanguage', () => {
  it('extracts language code from whisper-cli stderr', () => {
    const stderr = `whisper_full_with_state: auto-detected language: nl (p = 0.987654)\n`
    expect(parseDetectedLanguage(stderr)).toBe('nl')
  })
  it('handles English detection', () => {
    expect(parseDetectedLanguage('auto-detected language: en (p = 0.99)')).toBe('en')
  })
  it('returns null when not present', () => {
    expect(parseDetectedLanguage('no language line here')).toBe(null)
    expect(parseDetectedLanguage('')).toBe(null)
  })
  it('handles multiple lines and matches the first', () => {
    const s = 'log line\nauto-detected language: fr (p = 0.5)\nauto-detected language: de (p = 0.4)'
    expect(parseDetectedLanguage(s)).toBe('fr')
  })
})

describe('extFromContentType', () => {
  it('maps common audio MIMEs to extensions', () => {
    expect(extFromContentType('audio/mpeg')).toBe('mp3')
    expect(extFromContentType('audio/mp4')).toBe('m4a')
    expect(extFromContentType('audio/x-m4a')).toBe('m4a')
    expect(extFromContentType('audio/wav')).toBe('wav')
    expect(extFromContentType('audio/ogg')).toBe('ogg')
  })
  it('returns null for unknown types', () => {
    expect(extFromContentType('application/pdf')).toBe(null)
    expect(extFromContentType(undefined)).toBe(null)
  })
})
