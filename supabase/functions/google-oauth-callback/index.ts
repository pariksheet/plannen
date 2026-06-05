// Google's OAuth redirect lands here WITHOUT a user JWT. We open a pg
// connection with no user-context GUC so the handler can read/write
// service-role tables (oauth_state, user_oauth_tokens). The owning
// user_id is recovered from the oauth_state row inside the handler.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { Pool } from 'npm:pg@8'
import { handle } from '../_shared/handlers/google-oauth-callback.ts'
import type { DbClient } from '../_shared/handlers/types.ts'

const pool = new Pool({ connectionString: Deno.env.get('DATABASE_URL') ?? '' })

Deno.serve(async (req: Request) => {
  const client = await pool.connect()
  try {
    // No user-context GUC — this entry is the OAuth callback and has no JWT.
    // The handler relies on the state-row lookup to determine the user_id.
    return await handle(req, { db: client as unknown as DbClient, userId: '' })
  } finally {
    client.release()
  }
})
