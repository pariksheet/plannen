import { db } from './client.js'
import { validateName, validateStoreType } from './helpers.js'

export async function addStore(args: { name: string; type: string; notes?: string }) {
  const name = validateName(args.name)
  const type = validateStoreType(args.type)
  const { data, error } = await db
    .from('stores')
    .insert({ name, type, notes: args.notes ?? null })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listStores(args: { type?: string }) {
  let q = db.from('stores').select('id, name, type, notes, created_at').order('name', { ascending: true })
  if (args.type) {
    const type = validateStoreType(args.type)
    q = q.eq('type', type)
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function updateStore(args: { store_id: string; name?: string; type?: string; notes?: string }) {
  const patch: Record<string, unknown> = {}
  if (args.name !== undefined) patch.name = validateName(args.name)
  if (args.type !== undefined) patch.type = validateStoreType(args.type)
  if (args.notes !== undefined) patch.notes = args.notes
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const { data, error } = await db
    .from('stores')
    .update(patch)
    .eq('id', args.store_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteStore(args: { store_id: string }) {
  const { error } = await db.from('stores').delete().eq('id', args.store_id)
  if (error) throw new Error(error.message)
  return { ok: true }
}
