import { describe, it, expect } from 'vitest'
import { practicesModule } from './practices.ts'

describe('practices module', () => {
  it('registers 6 definitions', () => { expect(practicesModule.definitions).toHaveLength(6) })
  it('names', () => {
    expect(practicesModule.definitions.map((d) => d.name).sort()).toEqual(
      ['create_practice', 'delete_practice', 'list_practices', 'mark_practice_done', 'unmark_practice_done', 'update_practice']
    )
  })
  it('dispatch matches definitions', () => {
    for (const def of practicesModule.definitions) expect(typeof practicesModule.dispatch[def.name]).toBe('function')
  })
})
