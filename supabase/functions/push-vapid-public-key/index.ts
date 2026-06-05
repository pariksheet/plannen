import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { handleVapidPublicKey } from '../_shared/handlers/push.ts'
import { verifyJwt } from '../_shared/jwt.ts'

Deno.serve(async (req: Request) => {
  try {
    if (req.method === 'OPTIONS') return await handleVapidPublicKey(req)
    await verifyJwt(req.headers.get('authorization'))
    return await handleVapidPublicKey(req)
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
