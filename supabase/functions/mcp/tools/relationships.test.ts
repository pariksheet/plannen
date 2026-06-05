import { describe, it, expect } from 'vitest'
import { relationshipsModule } from './relationships.ts'

describe('relationships module', () => {
  it('registers 1 definition', () => { expect(relationshipsModule.definitions).toHaveLength(1) })
  it('name', () => { expect(relationshipsModule.definitions[0].name).toBe('list_relationships') })
  it('dispatch exists', () => { expect(typeof relationshipsModule.dispatch.list_relationships).toBe('function') })
})
