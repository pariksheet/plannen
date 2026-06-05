import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleSubscribe } from '../_shared/handlers/push.ts'
import { verifyJwt } from '../_shared/jwt.ts'
import { withDb } from '../_shared/db.ts'

Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') return await handleSubscribe(req, { db: null as never, userId: '' })
    const userId = await verifyJwt(req.headers.get('authorization'))
    return await withDb(userId, (db) => handleSubscribe(req, { db, userId }))
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
