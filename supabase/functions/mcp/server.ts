import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Pool } from 'npm:pg@8'
import { resolveTokenToUserId } from '../_shared/userTokens.ts'
import type { ToolModule } from './types.ts'

declare const Deno: { env: { get(k: string): string | undefined } } | undefined

function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

const pool = new Pool({ connectionString: envGet('DATABASE_URL') || envGet('SUPABASE_DB_URL') })

export type RequestAuth = { bearer: string } | { userId: string }

/**
 * Build a Server with the supplied tool modules wired in. Auth must be
 * supplied per request — there is no module-level user cache so two
 * concurrent users hitting the same function instance get distinct sessions.
 * Auth is either a plnnn_ PAT (resolved against plannen.user_tokens per
 * call) or an already-verified Supabase Auth user id (OAuth branch).
 */
export function buildServer(modules: ToolModule[], auth: RequestAuth) {
  const server = new Server(
    { name: 'plannen', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const definitions = modules.flatMap((m) => m.definitions)
  const dispatch: Record<string, ToolModule['dispatch'][string]> = {}
  for (const m of modules) Object.assign(dispatch, m.dispatch)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = dispatch[req.params.name]
    if (!handler) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
        isError: true,
      }
    }
    const client = await pool.connect()
    try {
      const userId = 'userId' in auth
        ? auth.userId
        : await resolveTokenToUserId(client, auth.bearer)
      if (!userId) {
        return { content: [{ type: 'text', text: 'invalid_token' }], isError: true }
      }
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
      const result = await handler(req.params.arguments ?? {}, { client, userId })
      await client.query('COMMIT')
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text', text: msg }], isError: true }
    } finally {
      client.release()
    }
  })

  return server
}

export { pool }
