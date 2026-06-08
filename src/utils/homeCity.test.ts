import { describe, it, expect } from 'vitest'
import { defaultCity } from './homeCity'
import type { UserLocation } from '../services/profileService'

function loc(overrides: Partial<UserLocation>): UserLocation {
  return {
    id: 'l', user_id: 'u', label: 'Home', address: '', city: 'Antwerp',
    country: 'BE', is_default: false, ...overrides,
  }
}

describe('defaultCity', () => {
  it('returns the default location city', () => {
    expect(defaultCity([
      loc({ id: 'a', city: 'Ghent', is_default: false }),
      loc({ id: 'b', city: 'Leuven', is_default: true }),
    ])).toBe('Leuven')
  })

  it('falls back to Brussels when there is no default', () => {
    expect(defaultCity([loc({ city: 'Ghent', is_default: false })])).toBe('Brussels')
    expect(defaultCity([])).toBe('Brussels')
  })

  it('falls back to Brussels when the default city is blank', () => {
    expect(defaultCity([loc({ city: '   ', is_default: true })])).toBe('Brussels')
  })
})
