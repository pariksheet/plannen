-- Mailbox sync rework. See docs/superpowers/specs/2026-05-27-mailbox-sync-rework-design.md
--
-- 1. mailbox_ignore_rules: rename `sender` → `pattern`, add `kind` enum, add
--    `subject_keyword`; UNIQUE constraint covers all three.
-- 2. event_provenance: new sidecar table tying an event to the source that
--    created it (mailbox today, room for manual/gcal/ics later).
-- 3. ignore_rule_matches(): SQL predicate used by retroactive sweep and
--    (mirrored in JS) by the sync agent's Step A.
-- 4. find_matching_mbsync_events(): RPC-callable wrapper for the sweep UI.

-- 1. ignore rules: expand columns and constraint.

ALTER TABLE plannen.mailbox_ignore_rules RENAME COLUMN sender TO pattern;

ALTER TABLE plannen.mailbox_ignore_rules
  ADD COLUMN kind text NOT NULL DEFAULT 'sender'
    CHECK (kind IN ('sender', 'domain', 'domain_subject')),
  ADD COLUMN subject_keyword text;

ALTER TABLE plannen.mailbox_ignore_rules
  DROP CONSTRAINT mailbox_ignore_rules_user_id_adapter_id_sender_key;

ALTER TABLE plannen.mailbox_ignore_rules
  ADD CONSTRAINT mailbox_ignore_rules_unique_rule
    UNIQUE NULLS NOT DISTINCT (user_id, adapter_id, kind, pattern, subject_keyword);

-- 2. event_provenance sidecar.

CREATE TABLE plannen.event_provenance (
  event_id          uuid PRIMARY KEY REFERENCES plannen.events(id) ON DELETE CASCADE,
  source            text NOT NULL,
  adapter_id        text,
  source_message_id text,
  sender_display    text,
  sender_email      text,
  sender_domain     text,
  subject           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_provenance_sender_domain
  ON plannen.event_provenance (sender_domain);

ALTER TABLE plannen.event_provenance ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.event_provenance TO anon;
GRANT ALL ON TABLE plannen.event_provenance TO authenticated;
GRANT ALL ON TABLE plannen.event_provenance TO service_role;

DROP POLICY IF EXISTS "Users can view provenance for events they can see"
  ON plannen.event_provenance;
CREATE POLICY "Users can view provenance for events they can see"
  ON plannen.event_provenance
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id
      AND (
        e.created_by = auth.uid()
        OR plannen.user_in_event_shared_with_users(e.id)
        OR plannen.user_in_event_group(e.id)
        OR (
          e.shared_with_friends = 'all'
          AND EXISTS (
            SELECT 1 FROM plannen.relationships r
            WHERE r.status = 'accepted'
              AND (
                (r.user_id = auth.uid() AND r.related_user_id = e.created_by)
                OR (r.user_id = e.created_by AND r.related_user_id = auth.uid())
              )
          )
        )
      )
  ));

DROP POLICY IF EXISTS "Event creator inserts provenance"
  ON plannen.event_provenance;
CREATE POLICY "Event creator inserts provenance"
  ON plannen.event_provenance
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id AND e.created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "Event creator updates provenance"
  ON plannen.event_provenance;
CREATE POLICY "Event creator updates provenance"
  ON plannen.event_provenance
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id AND e.created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "Event creator deletes provenance"
  ON plannen.event_provenance;
CREATE POLICY "Event creator deletes provenance"
  ON plannen.event_provenance
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id AND e.created_by = auth.uid()
  ));

-- 3. Match predicate.

CREATE OR REPLACE FUNCTION plannen.ignore_rule_matches(
  rule_kind text,
  rule_pattern text,
  rule_subject text,
  email_from text,
  email_subject text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  addr text;
  dom text;
BEGIN
  -- Extract bare address from "Name <addr@host>" if present, else use as-is.
  addr := lower(coalesce(
    substring(email_from from '<([^>]+)>'),
    email_from
  ));
  dom := split_part(addr, '@', 2);

  IF rule_kind = 'sender' THEN
    RETURN addr = lower(rule_pattern);
  ELSIF rule_kind = 'domain' THEN
    RETURN dom = lower(rule_pattern)
        OR dom LIKE '%.' || lower(rule_pattern);
  ELSIF rule_kind = 'domain_subject' THEN
    RETURN (dom = lower(rule_pattern)
            OR dom LIKE '%.' || lower(rule_pattern))
       AND lower(coalesce(email_subject, '')) LIKE '%' || lower(rule_subject) || '%';
  ELSE
    RETURN false;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION plannen.ignore_rule_matches(text, text, text, text, text)
  TO anon, authenticated, service_role;

-- 4. Sweep helper. SECURITY INVOKER (default): RLS on events + provenance applies.

CREATE OR REPLACE FUNCTION plannen.find_matching_mbsync_events(
  rule_kind text,
  rule_pattern text,
  rule_subject text
) RETURNS SETOF plannen.events
LANGUAGE sql
STABLE
AS $$
  SELECT e.*
  FROM plannen.events e
  JOIN plannen.event_provenance p ON p.event_id = e.id
  WHERE e.created_by = auth.uid()
    AND 'mbsync' = ANY(e.hashtags)
    AND plannen.ignore_rule_matches(
      rule_kind, rule_pattern, rule_subject,
      p.sender_email, p.subject
    )
  ORDER BY e.start_date DESC
  LIMIT 100;
$$;

GRANT EXECUTE ON FUNCTION plannen.find_matching_mbsync_events(text, text, text)
  TO anon, authenticated, service_role;
