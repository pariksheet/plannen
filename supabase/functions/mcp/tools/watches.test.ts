import { describe, it, expect } from 'vitest'
import { watchesModule } from './watches.ts'

describe('watches module', () => {
  it('registers 4 definitions', () => { expect(watchesModule.definitions).toHaveLength(4) })
  it('names', () => {
    expect(watchesModule.definitions.map((d) => d.name).sort()).toEqual([
      'create_watch_task', 'get_event_watch_task', 'get_watch_queue', 'update_watch_task',
    ])
  })
  it('dispatch matches definitions', () => {
    for (const def of watchesModule.definitions) expect(typeof watchesModule.dispatch[def.name]).toBe('function')
  })
})
