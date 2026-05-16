import { describe, it, expect } from 'vitest'
import { storiesModule } from './stories.ts'

describe('stories module', () => {
  it('registers exactly 5 tool definitions', () => {
    expect(storiesModule.definitions).toHaveLength(5)
  })
  it('names', () => {
    const names = storiesModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['create_story', 'delete_story', 'get_story', 'list_stories', 'update_story'])
  })
  it('every definition has a matching dispatch entry', () => {
    for (const def of storiesModule.definitions) {
      expect(typeof storiesModule.dispatch[def.name]).toBe('function')
    }
  })
})
