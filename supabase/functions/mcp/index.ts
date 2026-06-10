import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from './server.ts'
import { verifySupabaseJwt } from '../_shared/jwt.ts'
import type { ToolModule } from './types.ts'
import { eventsModule } from './tools/events.ts'
import { memoriesModule } from './tools/memories.ts'
import { storiesModule } from './tools/stories.ts'
import { photosModule } from './tools/photos.ts'
import { gcalModule } from './tools/gcal.ts'
import { relationshipsModule } from './tools/relationships.ts'
import { profileModule } from './tools/profile.ts'
import { familyModule } from './tools/family.ts'
import { locationsModule } from './tools/locations.ts'
import { watchesModule } from './tools/watches.ts'
import { sourcesModule } from './tools/sources.ts'
import { profileFactsModule } from './tools/profileFacts.ts'
import { practicesModule } from './tools/practices.ts'
import { schedulingModule } from './tools/scheduling.ts'
import { briefingsModule } from './tools/briefings.ts'
import { mailboxModule } from './tools/mailbox.ts'
import { provenanceModule } from './tools/provenance.ts'
import { activityModule } from './tools/activity.ts'

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

const WELL_KNOWN_SUFFIX = '/.well-known/oauth-protected-resource'

function mcpResourceUrl(): string {
  return `${envGet('SUPABASE_URL')}/functions/v1/mcp`
}

// RFC 9728 protected-resource metadata. Unauthenticated by design — it is
// discovery data; claude.ai fetches it after seeing the WWW-Authenticate
// header on a 401, then talks OAuth to Supabase Auth directly.
function protectedResourceMetadata(): Response {
  return new Response(
    JSON.stringify({
      resource: mcpResourceUrl(),
      authorization_servers: [`${envGet('SUPABASE_URL')}/auth/v1`],
      bearer_methods_supported: ['header'],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

function reply401(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      // Tells MCP clients (claude.ai) where to find the OAuth metadata.
      'WWW-Authenticate': `Bearer resource_metadata="${mcpResourceUrl()}${WELL_KNOWN_SUFFIX}"`,
    },
  })
}

export type AuthResult = { bearer: string } | { userId: string }

export async function authenticate(req: Request): Promise<AuthResult | Response> {
  const header = req.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return reply401('missing_bearer')
  const bearer = header.slice(prefix.length)
  // Static PAT branch (Claude Code plugin, CLI) — resolved per tool call
  // against plannen.user_tokens in server.ts.
  if (bearer.startsWith('plnnn_')) return { bearer }
  // OAuth branch (claude.ai connector) — bearer is a Supabase Auth JWT.
  const userId = await verifySupabaseJwt(bearer)
  if (!userId) return reply401('invalid_token')
  return { userId }
}

/**
 * Test-injectable wrapper. In production handleRequest is called with the
 * module-loaded tool list; tests pass {tools: []} to verify the transport
 * shape independently of the tool catalogue.
 */
export async function handleRequest(
  req: Request,
  opts: { tools: ToolModule[] } = { tools: [] },
): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname.endsWith(WELL_KNOWN_SUFFIX)) {
    return protectedResourceMetadata()
  }

  const auth = await authenticate(req)
  if (auth instanceof Response) return auth

  const server = buildServer(opts.tools, auth)
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return await transport.handleRequest(req)
}

// Module-level tool registry.
const TOOLS: ToolModule[] = [eventsModule, memoriesModule, storiesModule, photosModule, gcalModule, relationshipsModule, profileModule, familyModule, locationsModule, watchesModule, sourcesModule, profileFactsModule, practicesModule, schedulingModule, briefingsModule, mailboxModule, provenanceModule, activityModule]

if (typeof Deno !== 'undefined') {
  Deno.serve((req) => handleRequest(req, { tools: TOOLS }))
}
