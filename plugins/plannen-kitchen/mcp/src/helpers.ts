export const STORE_TYPES = ['supermarket', 'bakery', 'local', 'online', 'other'] as const
export const LIST_STATUSES = ['active', 'completed', 'archived'] as const
export const ITEM_STATUSES = ['pending', 'picked', 'skipped'] as const

export type StoreType = typeof STORE_TYPES[number]
export type ListStatus = typeof LIST_STATUSES[number]
export type ItemStatus = typeof ITEM_STATUSES[number]

export function validateStoreType(value: unknown): StoreType {
  if (typeof value !== 'string' || !(STORE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`invalid type: ${value}; expected one of ${STORE_TYPES.join(', ')}`)
  }
  return value as StoreType
}

export function validateListStatus(value: unknown): ListStatus {
  if (typeof value !== 'string' || !(LIST_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`invalid status: ${value}; expected one of ${LIST_STATUSES.join(', ')}`)
  }
  return value as ListStatus
}

export function validateItemStatus(value: unknown): ItemStatus {
  if (typeof value !== 'string' || !(ITEM_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`invalid status: ${value}; expected one of ${ITEM_STATUSES.join(', ')}`)
  }
  return value as ItemStatus
}

export function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('name required')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('name required')
  return trimmed
}

export function resolveDays(value: number | undefined): number {
  if (value === undefined) return 14
  if (value <= 0) throw new Error('days must be positive')
  if (value > 365) throw new Error('days must be <= 365')
  return value
}
