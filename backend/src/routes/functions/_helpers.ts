// Shared helper for all 12 `/functions/v1/<name>` route files. Opens a
// per-request transaction via `withUserContext`, exposes the pg client as
// a `DbClient` (structural subtype — pg's `.query()` returns more fields
// than `DbClient` cares about), and forwards the raw Web Request through
// to the pure handler.

import type { Context } from 'hono'
import { withUserContext } from '../../db.js'
import type { DbClient, Handler } from '../../_shared/handlers/types.js'
import type { AppVariables } from '../../types.js'

export function runHandler(c: Context<{ Variables: AppVariables }>, handle: Handler): Promise<Response> {
  return withUserContext(c.var.userId, (db) => handle(c.req.raw, { db: db as unknown as DbClient, userId: c.var.userId }))
}
