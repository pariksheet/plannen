import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const tier = import.meta.env.VITE_PLANNEN_TIER ?? '1'

// Tier 0 doesn't use Supabase Auth at all. But supabase-js auto-refreshes any
// stored session on import — which spams ERR_CONNECTION_REFUSED against a
// non-existent 54321 when a stale localStorage session lingers from Tier 1
// use. Detect Tier 0 and disable auth altogether (autoRefresh + persistSession
// off, and clear any stale storage entries on first import).
if (tier === '0' && typeof window !== 'undefined') {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k && (k.startsWith('sb-') || k.startsWith('supabase.auth.'))) {
        window.localStorage.removeItem(k)
      }
    }
  } catch {
    /* private mode, ignore */
  }
}

if (!url || !anonKey) {
  const msg = 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Run `bash scripts/bootstrap.sh` to generate .env, or set them manually before `npm run dev`.'
  console.error(msg)
  throw new Error(msg)
}

export const supabase = createClient(url, anonKey, {
  db: { schema: 'plannen' },
  auth: tier === '0'
    ? { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    : undefined,
})
