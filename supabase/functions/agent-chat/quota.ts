// Daily request quota for the UI action agent. Counter lives in
// plannen.agent_usage, keyed by (user_id, usage_date) where usage_date is the
// wall-clock date in the user's profile timezone (computed by the caller via
// logic.usageDateFor). The function checks BEFORE each model call and
// increments only on model-invoking turns — confirm taps / proposal executions
// never reach here.

export type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

// Current request count for the user on the given local date (0 if no row).
export async function getUsage(
  client: Queryable,
  userId: string,
  usageDate: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT request_count FROM plannen.agent_usage WHERE user_id = $1 AND usage_date = $2`,
    [userId, usageDate],
  )
  return rows.length ? Number(rows[0].request_count) : 0
}

// Atomically bump the counter (insert-or-add) and return the new total.
export async function incrementUsage(
  client: Queryable,
  userId: string,
  usageDate: string,
): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO plannen.agent_usage (user_id, usage_date, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, usage_date)
       DO UPDATE SET request_count = plannen.agent_usage.request_count + 1
     RETURNING request_count`,
    [userId, usageDate],
  )
  return Number(rows[0].request_count)
}
