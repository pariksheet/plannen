import { describe, it, expect } from 'vitest'
import { sourcesModule } from './sources.ts'

describe('sources module', () => {
  it('registers 4 definitions', () => { expect(sourcesModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(sourcesModule.definitions.map((d) => d.name).sort()).toEqual([
      'get_unanalysed_sources', 'save_source', 'search_sources', 'update_source',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of sourcesModule.definitions) expect(typeof sourcesModule.dispatch[def.name]).toBe('function')
  })
})
