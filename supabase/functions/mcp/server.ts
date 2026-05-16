import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Pool } from 'npm:pg@8'
import { resolveUserIdByEmail } from '../_shared/userResolver.ts'
import type { ToolModule } from './types.ts'

declare const Deno: { env: { get(k: string): string | undefined } } | undefined

function envGet(key: string): string {
  if (typeof Deno !== 'undefined') return Deno.env.get(key) ?? ''
  return process.env[key] ?? ''
}

const pool = new Pool({ connectionString: envGet('DATABASE_URL') })

const USER_EMAIL = envGet('PLANNEN_USER_EMAIL').toLowerCase()
let _userId: string | null = null

async function uid(): Promise<string> {
  if (_userId) return _userId
  _userId = await resolveUserIdByEmail(pool, USER_EMAIL)
  return _userId
}

/**
 * Build a Server with the supplied tool modules wired in. Exported so tests
 * can construct it with zero or partial modules.
 */
export function buildServer(modules: ToolModule[]) {
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
    const userId = await uid()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId])
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
      const result = await handler(req.params.arguments ?? {}, { client, userId })
      await client.query('COMMIT')
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      await client.query('ROLLBACK')
      const msg = e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text', text: msg }], isError: true }
    } finally {
      client.release()
    }
  })

  return server
}

export { pool }
