// Entry point for Plannen MCP HTTP server.
// Validates bearer auth, then hands off to the MCP server (Task 3+ wires the
// transport). Bearer is the shared MCP_BEARER_TOKEN env (single-user in Phase
// A; per-user tokens land in Phase A.1).

declare const Deno:
  | {
      env: { get(k: string): string | undefined }
      serve: (handler: (req: Request) => Promise<Response> | Response) => void
    }
  | undefined

/**
 * Constant-time compare to avoid timing oracles on the bearer token.
 * Returns true if equal, false otherwise (including length mismatch).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Returns null when the request's bearer matches MCP_BEARER_TOKEN.
 * Returns a 401 Response otherwise.
 */
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

if (typeof Deno !== 'undefined') {
  Deno.serve(async (req: Request) => {
    const authFailed = authenticate(req)
    if (authFailed) return authFailed
    // Task 3 wires the MCP transport here. Placeholder ack for now.
    return new Response(
      JSON.stringify({ status: 'authenticated', message: 'MCP transport not yet wired' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
}
