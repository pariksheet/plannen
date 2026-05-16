import { describe, it, expect } from 'vitest'
import { profileFactsModule } from './profileFacts.ts'

describe('profileFacts module', () => {
  it('registers 4 definitions', () => { expect(profileFactsModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(profileFactsModule.definitions.map((d) => d.name).sort()).toEqual([
      'correct_profile_fact', 'get_historical_facts', 'list_profile_facts', 'upsert_profile_fact',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of profileFactsModule.definitions) expect(typeof profileFactsModule.dispatch[def.name]).toBe('function')
  })
})
