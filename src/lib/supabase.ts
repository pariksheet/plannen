import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  const msg = 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Run `bash scripts/bootstrap.sh` to generate .env, or set them manually before `npm run dev`.'
  console.error(msg)
  throw new Error(msg)
}

export const supabase = createClient(url, anonKey, {
  db: { schema: 'plannen' },
})
