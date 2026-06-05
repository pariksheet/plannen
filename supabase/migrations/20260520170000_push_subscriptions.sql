-- Web Push subscriptions per user. One row per browser/device. The same user
-- on phone + laptop ends up as two rows because each has its own endpoint.
--
-- web-push deletes the row on 404/410 from the push gateway (Firebase / Apple
-- / Mozilla) — those endpoints are gone and would never resurrect.

CREATE TABLE IF NOT EXISTS plannen.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON plannen.push_subscriptions (user_id);

ALTER TABLE plannen.push_subscriptions ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.push_subscriptions TO anon;
GRANT ALL ON TABLE plannen.push_subscriptions TO authenticated;
GRANT ALL ON TABLE plannen.push_subscriptions TO service_role;

CREATE POLICY "Users select their own push subscriptions"
  ON plannen.push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert their own push subscriptions"
  ON plannen.push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update their own push subscriptions"
  ON plannen.push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete their own push subscriptions"
  ON plannen.push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);
