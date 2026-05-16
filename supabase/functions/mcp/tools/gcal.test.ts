import { describe, it, expect } from 'vitest'
import { gcalModule } from './gcal.ts'

describe('gcal module', () => {
  it('registers 2 definitions', () => { expect(gcalModule.definitions).toHaveLength(2) })
  it('names', () => {
    expect(gcalModule.definitions.map((d) => d.name).sort()).toEqual(['get_gcal_sync_candidates', 'set_gcal_event_id'])
  })
  it('dispatch matches definitions', () => {
    for (const def of gcalModule.definitions) expect(typeof gcalModule.dispatch[def.name]).toBe('function')
  })
})
