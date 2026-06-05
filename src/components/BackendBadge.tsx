import { useState } from 'react'
import { TIER } from '../lib/tier'
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '') as string

interface Badge {
  label: string
  color: string
  detail: string
}

function classify(): Badge {
  if (TIER === '0') {
    return { label: 'local pg', color: 'bg-amber-100 text-amber-900 ring-amber-300', detail: 'Tier 0 — embedded Postgres + Plannen backend' }
  }
  const isLoopback = SUPABASE_URL.startsWith('http://127.0.0.1') || SUPABASE_URL.startsWith('http://localhost')
  if (isLoopback) {
    return { label: 'local supabase', color: 'bg-blue-100 text-blue-900 ring-blue-300', detail: `Tier 1 — local Supabase Docker (${SUPABASE_URL})` }
  }
  if (TIER === '2' || SUPABASE_URL.endsWith('.supabase.co')) {
    return { label: 'cloud', color: 'bg-green-100 text-green-900 ring-green-300', detail: `Tier 2 — Supabase Cloud (${SUPABASE_URL})` }
  }
  return { label: 'unknown', color: 'bg-gray-100 text-gray-700 ring-gray-300', detail: SUPABASE_URL || 'no VITE_SUPABASE_URL' }
}

export function BackendBadge() {
  const [open, setOpen] = useState(false)
  const b = classify()
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className={`fixed bottom-2 right-2 z-50 text-[10px] font-medium px-2 py-1 rounded-full ring-1 ${b.color} opacity-70 hover:opacity-100 transition-opacity`}
      title={b.detail}
      aria-label={`Backend: ${b.detail}`}
    >
      {open ? b.detail : b.label}
    </button>
  )
}
