import { describe, it, expect } from 'vitest'
import { profileModule } from './profile.ts'

describe('profile module', () => {
  it('registers 4 definitions', () => { expect(profileModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(profileModule.definitions.map((d) => d.name).sort()).toEqual([
      'get_profile_context', 'get_story_languages', 'set_story_languages', 'update_profile',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of profileModule.definitions) expect(typeof profileModule.dispatch[def.name]).toBe('function')
  })
})
