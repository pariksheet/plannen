-- Move the default-share rule off user_settings (whose PK is (user_id,
-- provider) — one row PER AI provider, so it's the wrong home: a user with no
-- provider has no row, a multi-provider user has ambiguous rows) onto a proper
-- one-row-per-user table. Forward-only; the columns added in
-- 20260617150000 were unused, so this is safe.

CREATE TABLE IF NOT EXISTS plannen.user_share_defaults (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled     boolean NOT NULL DEFAULT false,
  target_type text CHECK (target_type IN ('user','group','all')),
  target_id   uuid,
  level       text NOT NULL DEFAULT 'awareness' CHECK (level = 'awareness'),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_share_defaults_target_shape CHECK (
    NOT enabled
    OR (target_type = 'all' AND target_id IS NULL)
    OR (target_type IN ('user','group') AND target_id IS NOT NULL)
  )
);
ALTER TABLE plannen.user_share_defaults ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE plannen.user_share_defaults TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Users manage own share defaults" ON plannen.user_share_defaults;
CREATE POLICY "Users manage own share defaults" ON plannen.user_share_defaults
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Carry over any value that was set on user_settings (likely none yet). Pick
-- one row per user deterministically.
INSERT INTO plannen.user_share_defaults (user_id, enabled, target_type, target_id, level)
SELECT DISTINCT ON (user_id)
       user_id, default_share_enabled, default_share_target_type, default_share_target_id, default_share_level
  FROM plannen.user_settings
 WHERE default_share_enabled IS TRUE
 ORDER BY user_id, updated_at DESC
ON CONFLICT (user_id) DO NOTHING;

-- Drop the misplaced columns.
ALTER TABLE plannen.user_settings
  DROP COLUMN IF EXISTS default_share_enabled,
  DROP COLUMN IF EXISTS default_share_target_type,
  DROP COLUMN IF EXISTS default_share_target_id,
  DROP COLUMN IF EXISTS default_share_level;
