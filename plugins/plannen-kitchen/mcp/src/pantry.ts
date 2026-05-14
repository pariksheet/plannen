import { db } from './client.js'
import { resolveDays, validateName } from './helpers.js'

export async function listPantry(args: { days?: number }) {
  const days = resolveDays(args.days)
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('pantry')
    .select('id, name, qty, store_id, store_name, picked_at, age')
    .gte('picked_at', cutoff)
    .order('picked_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getItemHistory(args: { name: string; limit?: number }) {
  const name = validateName(args.name).toLowerCase()
  const limit = args.limit ?? 5
  const { data, error } = await db
    .from('items')
    .select(`
      id, name, qty, aisle, picked_at,
      stores ( id, name, type ),
      lists ( id, name, week_of )
    `)
    .eq('status', 'picked')
    .ilike('name', name)
    .order('picked_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    qty: row.qty,
    aisle: row.aisle,
    picked_at: row.picked_at,
    store_id: row.stores?.id ?? null,
    store_name: row.stores?.name ?? null,
    store_type: row.stores?.type ?? null,
    list_id: row.lists?.id ?? null,
    list_name: row.lists?.name ?? null,
    list_week_of: row.lists?.week_of ?? null,
  }))
}
