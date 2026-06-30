-- Per-user daily request counter for the web UI action agent (the `agent-chat`
-- edge function). The UI agent is the ONLY surface where the app runs its own
-- server-side inference loop on an app-provided (not BYOK) key, so it is the
-- only surface we meter. One model-invoking user message = 1 request; confirm
-- taps and proposal executions invoke no model and are NOT counted (the
-- function never increments on those paths). `usage_date` is computed in the
-- user's profile timezone so the daily reset boundary matches event bucketing
-- (midnight local), not UTC.
--
-- Forward-only; no backfill (no usage exists yet).

CREATE TABLE IF NOT EXISTS plannen.agent_usage (
  user_id       uuid    NOT NULL,
  usage_date    date    NOT NULL,   -- computed in the user's profile TZ by agent-chat
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);
ALTER TABLE plannen.agent_usage OWNER TO postgres;

GRANT ALL ON TABLE plannen.agent_usage TO anon, authenticated, service_role;

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Owner-only: a user sees and mutates only their own counter rows. The
-- agent-chat function runs under the caller's user-context GUCs (auth.uid()),
-- same as every other plannen table.
ALTER TABLE plannen.agent_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can view agent_usage" ON plannen.agent_usage;
CREATE POLICY "Owners can view agent_usage" ON plannen.agent_usage
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Owners can insert agent_usage" ON plannen.agent_usage;
CREATE POLICY "Owners can insert agent_usage" ON plannen.agent_usage
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Owners can update agent_usage" ON plannen.agent_usage;
CREATE POLICY "Owners can update agent_usage" ON plannen.agent_usage
  FOR UPDATE USING (user_id = auth.uid());
