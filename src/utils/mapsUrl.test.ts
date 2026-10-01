import { describe, it, expect } from 'vitest'
import { mapsSearchUrl } from './mapsUrl'

describe('mapsSearchUrl', () => {
  it('builds the documented Maps URLs search form (api=1&query=) so the Maps app accepts it', () => {
    const url = new URL(mapsSearchUrl('Sportpark Zemst, Belgium'))
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/search/')
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('query')).toBe('Sportpark Zemst, Belgium')
    expect(url.searchParams.has('q')).toBe(false)
  })

  it('percent-encodes characters that would break the query', () => {
    expect(mapsSearchUrl('Rue de l\'Église 5 & co')).toContain('query=Rue%20de%20l\'%C3%89glise%205%20%26%20co')
  })
})
