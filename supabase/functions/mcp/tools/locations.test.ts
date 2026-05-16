import { describe, it, expect } from 'vitest'
import { locationsModule } from './locations.ts'

describe('locations module', () => {
  it('registers 2 definitions', () => { expect(locationsModule.definitions).toHaveLength(2) })
  it('names', () => {
    expect(locationsModule.definitions.map((d) => d.name).sort()).toEqual(['add_location', 'list_locations'])
  })
  it('dispatch matches definitions', () => {
    for (const def of locationsModule.definitions) expect(typeof locationsModule.dispatch[def.name]).toBe('function')
  })
})
