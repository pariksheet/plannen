// Runtime-agnostic handler types. Both Deno (Tier 1) and Node (Tier 0) inject
// matching shapes via the runtime-specific entry points.
//
// Handlers in this directory are written once and called from:
//   • Tier 1: each `supabase/functions/<name>/index.ts` (verifies JWT + opens
//     a per-request pg client, both via `_shared/jwt.ts` and `_shared/db.ts`).
//   • Tier 0: `backend/src/routes/functions/<name>.ts` (uses the long-lived
//     pool from `backend/src/db.ts` + the user resolved at boot).
//
// Keep this file dependency-free so Node and Deno can both import it.

export type DbClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>
}

export type HandlerCtx = {
  db: DbClient
  userId: string
}

export type Handler = (req: Request, ctx: HandlerCtx) => Promise<Response>
