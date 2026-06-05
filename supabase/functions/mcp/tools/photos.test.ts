import { describe, it, expect } from 'vitest'
import { photosModule } from './photos.ts'

describe('photos module', () => {
  it('registers exactly 2 tool definitions', () => {
    expect(photosModule.definitions).toHaveLength(2)
  })
  it('names', () => {
    const names = photosModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['create_photo_picker_session', 'poll_photo_picker_session'])
  })
  it('every definition has a matching dispatch entry', () => {
    for (const def of photosModule.definitions) {
      expect(typeof photosModule.dispatch[def.name]).toBe('function')
    }
  })
})
