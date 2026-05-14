import { useEffect, useState } from 'react'
import { kitchenDb } from './supabase'

type Item = {
  id: string
  name: string
  qty: string | null
  store_id: string | null
  store_name: string | null
  store_type: string | null
  aisle: string | null
  status: 'pending' | 'picked' | 'skipped'
  picked_at: string | null
}

type List = {
  id: string
  name: string
  week_of: string | null
  status: 'active' | 'completed' | 'archived'
}

async function fetchActiveList(): Promise<List | null> {
  const { data, error } = await kitchenDb
    .from('lists')
    .select('id, name, week_of, status')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error(error)
    return null
  }
  return data as List | null
}

async function fetchItems(listId: string): Promise<Item[]> {
  const { data, error } = await kitchenDb
    .from('items')
    .select(`
      id, name, qty, store_id, aisle, status, picked_at,
      stores ( name, type )
    `)
    .eq('list_id', listId)
    .order('status', { ascending: true })
    .order('aisle', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (error) {
    console.error(error)
    return []
  }
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    qty: row.qty,
    store_id: row.store_id,
    store_name: row.stores?.name ?? null,
    store_type: row.stores?.type ?? null,
    aisle: row.aisle,
    status: row.status,
    picked_at: row.picked_at,
  }))
}

async function toggleItem(itemId: string, currentStatus: Item['status']): Promise<void> {
  const next = currentStatus === 'picked'
    ? { status: 'pending' as const, picked_at: null }
    : { status: 'picked' as const, picked_at: new Date().toISOString() }
  const { error } = await kitchenDb.from('items').update(next).eq('id', itemId)
  if (error) {
    console.error(error)
    throw error
  }
}

function groupByStore(items: Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>()
  for (const item of items) {
    const key = item.store_name ?? 'Unassigned'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  return groups
}

export default function ShopView() {
  const [list, setList] = useState<List | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const active = await fetchActiveList()
      if (cancelled) return
      setList(active)
      if (active) {
        const rows = await fetchItems(active.id)
        if (!cancelled) setItems(rows)
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>
  if (!list) {
    return (
      <div className="p-6 text-gray-700">
        <h1 className="text-lg font-semibold mb-2">No active shopping list</h1>
        <p className="text-sm">Ask Claude to start one: paste this week's WhatsApp list into the chat and Claude will populate it. Then come back here to check off.</p>
      </div>
    )
  }

  const picked = items.filter(i => i.status === 'picked').length
  const total = items.length
  const grouped = groupByStore(items)

  async function handleToggle(item: Item) {
    const next: Item['status'] = item.status === 'picked' ? 'pending' : 'picked'
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: next, picked_at: next === 'picked' ? new Date().toISOString() : null } : i))
    try {
      await toggleItem(item.id, item.status)
    } catch {
      setItems(prev => prev.map(i => i.id === item.id ? item : i))
    }
  }

  return (
    <div className="max-w-md mx-auto pb-12">
      <header className="sticky top-0 bg-white border-b px-4 py-3 flex justify-between items-center">
        <div>
          <h1 className="text-base font-semibold">{list.name}</h1>
          {list.week_of && <div className="text-xs text-gray-500">week of {list.week_of}</div>}
        </div>
        <div className="text-sm font-mono">{picked} / {total}</div>
      </header>

      {[...grouped.entries()].map(([storeName, storeItems]) => {
        const remaining = storeItems.filter(i => i.status !== 'picked').length
        return (
          <section key={storeName} className="border-b">
            <h2 className="px-4 py-2 text-sm font-medium bg-gray-50 flex justify-between">
              <span>{storeName}</span>
              <span className="text-gray-500">{remaining} left</span>
            </h2>
            <ul>
              {storeItems.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleToggle(item)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 active:bg-gray-100 ${
                      item.status === 'picked' ? 'text-gray-400 line-through' : ''
                    }`}
                  >
                    <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-xs ${
                      item.status === 'picked' ? 'bg-green-500 border-green-500 text-white' : 'border-gray-300'
                    }`}>
                      {item.status === 'picked' ? '✓' : ''}
                    </span>
                    <span className="flex-1">
                      <span className="block">{item.name}{item.qty ? ` · ${item.qty}` : ''}</span>
                      {item.aisle && <span className="block text-xs text-gray-500">aisle: {item.aisle}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
