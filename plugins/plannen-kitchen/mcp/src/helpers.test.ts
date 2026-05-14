import { describe, it, expect } from 'vitest'
import {
  STORE_TYPES,
  LIST_STATUSES,
  ITEM_STATUSES,
  validateStoreType,
  validateListStatus,
  validateItemStatus,
  validateName,
  resolveDays,
} from './helpers.js'

describe('validateStoreType', () => {
  it('accepts every member of STORE_TYPES', () => {
    for (const t of STORE_TYPES) expect(validateStoreType(t)).toBe(t)
  })
  it('throws on unknown type', () => {
    expect(() => validateStoreType('hypermarket')).toThrow(/invalid type/)
  })
  it('throws on empty string', () => {
    expect(() => validateStoreType('')).toThrow(/invalid type/)
  })
})

describe('validateListStatus', () => {
  it('accepts every member of LIST_STATUSES', () => {
    for (const s of LIST_STATUSES) expect(validateListStatus(s)).toBe(s)
  })
  it('throws on unknown status', () => {
    expect(() => validateListStatus('frozen')).toThrow(/invalid status/)
  })
})

describe('validateItemStatus', () => {
  it('accepts every member of ITEM_STATUSES', () => {
    for (const s of ITEM_STATUSES) expect(validateItemStatus(s)).toBe(s)
  })
  it('throws on unknown status', () => {
    expect(() => validateItemStatus('done')).toThrow(/invalid status/)
  })
})

describe('validateName', () => {
  it('returns trimmed name', () => {
    expect(validateName('  milk  ')).toBe('milk')
  })
  it('throws "name required" for empty string', () => {
    expect(() => validateName('')).toThrow('name required')
  })
  it('throws "name required" for whitespace-only string', () => {
    expect(() => validateName('   ')).toThrow('name required')
  })
})

describe('resolveDays', () => {
  it('defaults to 14 when undefined', () => {
    expect(resolveDays(undefined)).toBe(14)
  })
  it('returns the supplied value when valid', () => {
    expect(resolveDays(7)).toBe(7)
    expect(resolveDays(30)).toBe(30)
  })
  it('throws on zero', () => {
    expect(() => resolveDays(0)).toThrow(/days must be positive/)
  })
  it('throws on negative', () => {
    expect(() => resolveDays(-1)).toThrow(/days must be positive/)
  })
  it('caps at 365', () => {
    expect(() => resolveDays(366)).toThrow(/days must be <= 365/)
  })
})
