import { describe, it, expect } from 'vitest'
import {
  assertUpdatableKeys,
  UPDATE_EVENT_FIELDS,
  UPDATE_PRACTICE_FIELDS,
  UPDATE_ATTENDANCE_FIELDS,
  UPDATE_OBLIGATION_FIELDS,
} from './updatableFields.js'

describe('assertUpdatableKeys', () => {
  it('accepts id plus allowed fields', () => {
    expect(() => assertUpdatableKeys({ id: 'x', title: 't' }, UPDATE_EVENT_FIELDS)).not.toThrow()
  })

  it('rejects a key that is not a column name', () => {
    expect(() => assertUpdatableKeys({ id: 'x', "title = 'x' --": 'v' }, UPDATE_EVENT_FIELDS)).toThrow(/unknown field/)
  })

  it.each([
    ['event', UPDATE_EVENT_FIELDS],
    ['practice', UPDATE_PRACTICE_FIELDS],
    ['attendance', UPDATE_ATTENDANCE_FIELDS],
    ['obligation', UPDATE_OBLIGATION_FIELDS],
  ])('%s allowlist excludes ownership columns', (_name, fields) => {
    expect(() => assertUpdatableKeys({ id: 'x', created_by: 'u2' }, fields)).toThrow(/unknown field/)
    expect(() => assertUpdatableKeys({ id: 'x', user_id: 'u2' }, fields)).toThrow(/unknown field/)
  })
})
