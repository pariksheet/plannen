import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// .env lives at repo root. From plugins/plannen-kitchen/mcp/src/client.ts the
// path is four parents up.
const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(__dirname, '../../../../.env') })

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const USER_EMAIL = (process.env.PLANNEN_USER_EMAIL ?? '').toLowerCase()

function fatal(msg: string): never {
  process.stderr.write(`[plannen-kitchen-mcp] ${msg}\n`)
  process.exit(1)
}

if (!SERVICE_ROLE_KEY) fatal('SUPABASE_SERVICE_ROLE_KEY is required')
if (!USER_EMAIL) fatal('PLANNEN_USER_EMAIL is required')

export const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'kitchen' },
})

let _userId: string | null = null

export async function uid(): Promise<string> {
  if (_userId) return _userId
  const { data, error } = await db.auth.admin.listUsers()
  if (error) throw new Error(`Auth error: ${error.message}`)
  const user = data.users.find(u => u.email?.toLowerCase() === USER_EMAIL)
  if (!user) {
    throw new Error(
      `No Plannen account found for ${USER_EMAIL}. Sign in to the Plannen app at least once first.`
    )
  }
  _userId = user.id
  return _userId
}
