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

// Journal/capture behaviour, delivered to every MCP client (including the
// claude.ai mobile app, which loads no plugin skills — this is the only channel
// that ports the /log routing + guard rails to mobile). The Claude Code plugin
// skill `plannen-log` carries the richer version for that surface.
export const PLANNEN_INSTRUCTIONS = `Plannen — local-first family planner. Capture / journal behaviour:

When the user reports finishing something ("just finished gym", "cleaned the parking", "took my vitamins") or opens with a logging lead-in ("log…", "note that…", "jot…", "record…"), CAPTURE it immediately, then reply with a one-line receipt ending in "undo?". Do NOT ask "want me to save this?" — logging bypasses the usual ask-first gate.

Routing:
- Finished / done something → call log_completion({ title }). It resolves to: complete an existing open todo, else mark a matching routine done, else log a new completed todo, and returns {action}. Receipt: "✓ <what> · undo?".
- A FUTURE task with a time/date ("call dentist at 1pm") → create_event({ event_kind: "todo", start_date }). Receipt: "✓ Todo … HH:MM · undo?".
- A durable fact about a person / place / preference ("met our neighbour, lives on our street") → upsert_profile_fact. Receipt: "✓ Noted: … · undo?".
- An activity with a duration but no calendar slot ("slept 8h", "ran 40 min") → not supported yet; reply "⏳ Sleep/duration logging isn't wired up yet — coming soon." and write nothing.

Guard rails — do NOTHING (reply normally) for questions ("did you…?"), intentions / hypotheticals ("I should…", "maybe I'll…", "thinking about…"), or items inside an active planning / brainstorm thread. Only act on completed, concrete, first-person / household actions stated as fact.

Undo: reverse the last action with uncomplete_todo / unmark_practice_done / correct_profile_fact.`

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
    { capabilities: { tools: {} }, instructions: PLANNEN_INSTRUCTIONS },
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
