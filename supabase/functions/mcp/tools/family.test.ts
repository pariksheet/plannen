import { describe, it, expect } from 'vitest'
import { familyModule } from './family.ts'

describe('family module', () => {
  it('registers 2 definitions', () => { expect(familyModule.definitions).toHaveLength(2) })
  it('names', () => {
    expect(familyModule.definitions.map((d) => d.name).sort()).toEqual(['add_family_member', 'list_family_members'])
  })
  it('dispatch matches definitions', () => {
    for (const def of familyModule.definitions) expect(typeof familyModule.dispatch[def.name]).toBe('function')
  })
})
