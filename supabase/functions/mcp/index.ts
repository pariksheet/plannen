import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildServer } from './server.ts'
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

declare const Deno:
  | {
      env: { get(k: string): string | undefined }
      serve: (handler: (req: Request) => Promise<Response> | Response) => void
    }
  | undefined

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function authenticate(req: Request): Response | null {
  const expected =
    (typeof Deno !== 'undefined' ? Deno.env.get('MCP_BEARER_TOKEN') : process.env.MCP_BEARER_TOKEN) ?? ''
  const header = req.headers.get('Authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) {
    return new Response(JSON.stringify({ error: 'missing_bearer' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const supplied = header.slice(prefix.length)
  if (!expected || !constantTimeEqual(supplied, expected)) {
    return new Response(JSON.stringify({ error: 'invalid_bearer' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
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
  const authFailed = authenticate(req)
  if (authFailed) return authFailed

  const server = buildServer(opts.tools)
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return await transport.handleRequest(req)
}

// Module-level tool registry.
const TOOLS: ToolModule[] = [eventsModule, memoriesModule, storiesModule, photosModule, gcalModule, relationshipsModule, profileModule, familyModule, locationsModule, watchesModule, sourcesModule]

if (typeof Deno !== 'undefined') {
  Deno.serve((req) => handleRequest(req, { tools: TOOLS }))
}
