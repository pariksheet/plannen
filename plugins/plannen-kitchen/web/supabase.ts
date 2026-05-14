import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  const msg = 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Run bootstrap.sh first.'
  console.error(msg)
  throw new Error(msg)
}

export const kitchenDb = createClient(url, anonKey, {
  db: { schema: 'kitchen' },
})
