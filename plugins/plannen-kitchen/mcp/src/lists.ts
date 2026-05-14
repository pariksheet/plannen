import { db } from './client.js'
import { validateListStatus, validateName } from './helpers.js'

export async function createList(args: { name: string; week_of?: string; notes?: string }) {
  const name = validateName(args.name)
  const { data, error } = await db
    .from('lists')
    .insert({
      name,
      week_of: args.week_of ?? null,
      notes: args.notes ?? null,
      status: 'active',
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listLists(args: { status?: string; limit?: number }) {
  const limit = args.limit ?? 10
  let q = db
    .from('lists')
    .select('id, name, week_of, status, notes, created_at')
    .order('created_at', { ascending: false })
    .limit(limit + 1)
  if (args.status) {
    const status = validateListStatus(args.status)
    q = q.eq('status', status)
  }
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = data ?? []
  const truncated = rows.length > limit
  const out = truncated ? rows.slice(0, limit) : rows

  // Enrich with item counts in a single batched query per page.
  if (out.length === 0) return { lists: [], truncated }
  const listIds = out.map(l => l.id)
  const { data: counts, error: cErr } = await db
    .from('items')
    .select('list_id, status')
    .in('list_id', listIds)
  if (cErr) throw new Error(cErr.message)

  const byList = new Map<string, { total: number; picked: number }>()
  for (const id of listIds) byList.set(id, { total: 0, picked: 0 })
  for (const row of counts ?? []) {
    const entry = byList.get(row.list_id)
    if (!entry) continue
    entry.total += 1
    if (row.status === 'picked') entry.picked += 1
  }

  return {
    lists: out.map(l => ({
      ...l,
      item_count: byList.get(l.id)?.total ?? 0,
      picked_count: byList.get(l.id)?.picked ?? 0,
    })),
    truncated,
  }
}

export async function updateList(args: { list_id: string; name?: string; status?: string; notes?: string }) {
  const patch: Record<string, unknown> = {}
  if (args.name !== undefined) patch.name = validateName(args.name)
  if (args.status !== undefined) patch.status = validateListStatus(args.status)
  if (args.notes !== undefined) patch.notes = args.notes
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const { data, error } = await db
    .from('lists')
    .update(patch)
    .eq('id', args.list_id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}
