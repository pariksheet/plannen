// Entry point for Plannen MCP HTTP server.
// Tasks 2+ wire up bearer auth and the MCP transport. This stub exists so
// `supabase functions serve mcp` boots cleanly during scaffold.

Deno.serve((_req: Request) => {
  return new Response(
    JSON.stringify({ status: 'scaffold', message: 'MCP function not yet wired' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
})
