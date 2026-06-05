-- mailbox_ignore_rules: per-user, per-adapter single-sender mute list.
-- Used by /plannen-mailbox-sync to skip senders the user dismissed.
-- One rule per (user, adapter, sender) — single-sender granularity by design;
-- subject patterns are out of scope for v1.

CREATE TABLE IF NOT EXISTS plannen.mailbox_ignore_rules (
  id                uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id           uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  adapter_id        text NOT NULL CHECK (length(adapter_id) > 0),
  sender            text NOT NULL CHECK (length(sender) > 0),
  source_event_id   uuid REFERENCES plannen.events(id) ON DELETE SET NULL,
  source_message_id text,
  reason            text,
  hit_count         int  NOT NULL DEFAULT 0,
  last_hit_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, adapter_id, sender)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_ignore_rules_user
  ON plannen.mailbox_ignore_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_ignore_rules_lookup
  ON plannen.mailbox_ignore_rules(user_id, adapter_id, sender);

ALTER TABLE plannen.mailbox_ignore_rules ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.mailbox_ignore_rules TO anon;
GRANT ALL ON TABLE plannen.mailbox_ignore_rules TO authenticated;
GRANT ALL ON TABLE plannen.mailbox_ignore_rules TO service_role;

DROP POLICY IF EXISTS "Users manage their own ignore rules"
  ON plannen.mailbox_ignore_rules;
CREATE POLICY "Users manage their own ignore rules"
  ON plannen.mailbox_ignore_rules
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
