-- mailbox_sync_state: per-user, per-adapter checkpoint for /plannen-mailbox-sync.
-- Replaces the previous Gmail-label-based "mark processed" scheme. The skill
-- reads last_synced_at at the start of each run and advances it at the end
-- to the internal date of the latest successfully-processed message.

CREATE TABLE IF NOT EXISTS plannen.mailbox_sync_state (
  user_id        uuid        NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  adapter_id     text        NOT NULL CHECK (length(adapter_id) > 0),
  last_synced_at timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, adapter_id)
);

ALTER TABLE plannen.mailbox_sync_state ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.mailbox_sync_state TO anon;
GRANT ALL ON TABLE plannen.mailbox_sync_state TO authenticated;
GRANT ALL ON TABLE plannen.mailbox_sync_state TO service_role;

DROP POLICY IF EXISTS "Users manage their own sync state"
  ON plannen.mailbox_sync_state;
CREATE POLICY "Users manage their own sync state"
  ON plannen.mailbox_sync_state
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
