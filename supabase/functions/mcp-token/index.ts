// supabase/functions/mcp-token/index.ts
//
// Per-user MCP PAT management — used by /settings in the web UI.
// Authenticates with the user's Supabase JWT (verifyJwt). All operations
// are scoped to that user.
//
// POST   { label, expires_at? }   → 200 { id, plaintext, prefix, label, created_at, expires_at }
// GET                              → 200 [ { id, label, prefix, created_at, last_used_at, expires_at } ]
// DELETE /:id                      → 204 on success, 404 if not owned by caller

import { Pool } from 'npm:pg@8'
import { verifyJwt } from '../_shared/jwt.ts'
import { mintToken, listTokens, revokeToken } from '../_shared/userTokens.ts'

declare const Deno:
  | {
      env: { get(k: string): string | undefined }
      serve: (handler: (req: Request) => Promise<Response> | Response) => void
    }
  | undefined

function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

const pool = new Pool({ connectionString: envGet('DATABASE_URL') || envGet('SUPABASE_DB_URL') })

type Ctx = { db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> } }

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  let userId: string
  try {
    userId = await verifyJwt(req.headers.get('Authorization'))
  } catch (e) {
    return jsonResp(401, { error: 'unauthenticated', detail: (e as Error).message })
  }

  if (req.method === 'POST') {
    let body: { label?: string; expires_at?: string | null }
    try { body = await req.json() } catch { return jsonResp(400, { error: 'invalid_json' }) }
    if (!body.label || body.label.trim().length === 0) {
      return jsonResp(400, { error: 'label_required' })
    }
    const r = await mintToken(ctx.db as any, userId, body.label, body.expires_at ?? null)
    return jsonResp(200, {
      id: r.id, plaintext: r.plaintext, prefix: r.prefix, label: body.label.trim(),
      created_at: new Date().toISOString(),
      expires_at: body.expires_at ?? null,
    })
  }

  if (req.method === 'GET') {
    const rows = await listTokens(ctx.db as any, userId)
    return jsonResp(200, rows)
  }

  if (req.method === 'DELETE') {
    const id = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
    if (!id) return jsonResp(400, { error: 'id_required' })
    const ok = await revokeToken(ctx.db as any, userId, id)
    return ok ? new Response(null, { status: 204, headers: corsHeaders }) : jsonResp(404, { error: 'not_found' })
  }

  return jsonResp(405, { error: 'method_not_allowed' })
}

if (typeof Deno !== 'undefined') {
  Deno.serve(async (req) => {
    const client = await pool.connect()
    try {
      const ctx: Ctx = { db: { query: (sql, params) => client.query(sql, params) } }
      return await handle(req, ctx)
    } finally {
      client.release()
    }
  })
}
