// Cron entry — no JWT. We open a raw pg client without setting the user GUC
// so the handler can read events across all users (service-role equivalent).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { Pool } from 'npm:pg@8'
import { handle } from '../_shared/handlers/send-reminder.ts'
import type { DbClient } from '../_shared/handlers/types.ts'

const pool = new Pool({ connectionString: Deno.env.get('DATABASE_URL') ?? '' })

Deno.serve(async (req: Request) => {
  const client = await pool.connect()
  try {
    return await handle(req, { db: client as unknown as DbClient, userId: '' })
  } finally {
    client.release()
  }
})
