import { describe, it, expect } from 'vitest'
import { memoriesModule } from './memories.ts'

describe('memories module', () => {
  it('registers exactly 2 tool definitions', () => {
    expect(memoriesModule.definitions).toHaveLength(2)
  })
  it('names', () => {
    const names = memoriesModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['add_event_memory', 'list_event_memories'])
  })
  it('does NOT include transcribe_memory (intentionally dropped in Phase A)', () => {
    expect(memoriesModule.definitions.find((d) => d.name === 'transcribe_memory')).toBeUndefined()
    expect(memoriesModule.dispatch.transcribe_memory).toBeUndefined()
  })
  it('every definition has a matching dispatch entry', () => {
    for (const def of memoriesModule.definitions) {
      expect(typeof memoriesModule.dispatch[def.name]).toBe('function')
    }
  })
})
