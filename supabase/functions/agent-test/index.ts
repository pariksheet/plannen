import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handle } from '../_shared/handlers/agent-test.ts'
import { verifyJwt } from '../_shared/jwt.ts'
import { withDb } from '../_shared/db.ts'

Deno.serve(async (req: Request) => {
  try {
    const userId = await verifyJwt(req.headers.get('authorization'))
    return await withDb(userId, (db) => handle(req, { db, userId }))
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
