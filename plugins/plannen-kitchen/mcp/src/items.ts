import { db } from './client.js'
import { validateItemStatus, validateName } from './helpers.js'

export async function addItem(args: {
  list_id: string
  name: string
  qty?: string
  store_id?: string
  aisle?: string
  notes?: string
}) {
  const name = validateName(args.name)
  const { data, error } = await db
    .from('items')
    .insert({
      list_id: args.list_id,
      name,
      qty: args.qty ?? null,
      store_id: args.store_id ?? null,
      aisle: args.aisle ?? null,
      notes: args.notes ?? null,
      status: 'pending',
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listItems(args: { list_id: string; status?: string }) {
  let q = db
    .from('items')
    .select(`
      id, list_id, name, qty, store_id, aisle, status, picked_at, notes,
      stores ( name, type )
    `)
    .eq('list_id', args.list_id)
    .order('aisle', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (args.status) {
    const status = validateItemStatus(args.status)
    q = q.eq('status', status)
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []).map((row: any) => ({
    id: row.id,
    list_id: row.list_id,
    name: row.name,
    qty: row.qty,
    store_id: row.store_id,
    store_name: row.stores?.name ?? null,
    store_type: row.stores?.type ?? null,
    aisle: row.aisle,
    status: row.status,
    picked_at: row.picked_at,
    notes: row.notes,
  }))
}

export async function updateItem(args: {
  item_id: string
  name?: string
  qty?: string
  store_id?: string | null
  aisle?: string | null
  notes?: string | null
}) {
  const patch: Record<string, unknown> = {}
  if (args.name !== undefined) patch.name = validateName(args.name)
  if (args.qty !== undefined) patch.qty = args.qty
  if (args.store_id !== undefined) patch.store_id = args.store_id
  if (args.aisle !== undefined) patch.aisle = args.aisle
  if (args.notes !== undefined) patch.notes = args.notes
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const { data, error } = await db
    .from('items')
    .update(patch)
    .eq('id', args.item_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function checkOffItem(args: { item_id: string }) {
  const { data, error } = await db
    .from('items')
    .update({ status: 'picked', picked_at: new Date().toISOString() })
    .eq('id', args.item_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteItem(args: { item_id: string }) {
  const { error } = await db.from('items').delete().eq('id', args.item_id)
  if (error) throw new Error(error.message)
  return { ok: true }
}
