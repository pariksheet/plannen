-- Retire events.shared_with_friends entirely. Every event-visibility policy
-- already OR-ed in user_in_event_group + user_in_event_shared_with_users
-- (both repointed to event_shares) and only used the column for the
-- 'all' branch — which plannen.user_can_see_event() now covers (user + group
-- + all + trip). So each policy collapses to:
--     created_by = auth.uid() OR plannen.user_can_see_event(e.id)
-- which also fixes the gap where 'all'-target shares (written to event_shares,
-- not the column) didn't expose rsvps/memories/etc.

-- 1. join_event_by_invite: it still wrote the dropped event_shared_with_users
--    junction (see 20260617170000) and bumped shared_with_friends. Rewrite to
--    add a unified event_shares row and stop touching the column.
CREATE OR REPLACE FUNCTION plannen.join_event_by_invite(invite_token text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = plannen
AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_event_id uuid;
  v_owner    uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT i.event_id INTO v_event_id
  FROM plannen.event_invites i
  WHERE i.token = TRIM(invite_token)
    AND (i.expires_at IS NULL OR i.expires_at > NOW());

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'Invalid or expired invite';
  END IF;

  SELECT e.created_by INTO v_owner FROM plannen.events e WHERE e.id = v_event_id;

  INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by)
  VALUES (v_event_id, 'user', v_user_id, 'awareness', v_owner)
  ON CONFLICT (event_id, target_type, target_id) DO NOTHING;

  RETURN v_event_id;
END;
$$;

-- 2. Collapse every event-visibility policy onto user_can_see_event.
DROP POLICY IF EXISTS "Users can view RSVPs for events they can see" ON plannen.event_rsvps;
CREATE POLICY "Users can view RSVPs for events they can see" ON plannen.event_rsvps
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_rsvps.event_id
      AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id))
  ));

DROP POLICY IF EXISTS "Users can view memories for events they can see" ON plannen.event_memories;
CREATE POLICY "Users can view memories for events they can see" ON plannen.event_memories
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_memories.event_id
      AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id))
  ));

DROP POLICY IF EXISTS "Users can view notes for events they can see" ON plannen.event_notes;
CREATE POLICY "Users can view notes for events they can see" ON plannen.event_notes
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_notes.event_id
      AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id))
  ));

DROP POLICY IF EXISTS "Users can view provenance for events they can see" ON plannen.event_provenance;
CREATE POLICY "Users can view provenance for events they can see" ON plannen.event_provenance
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id
      AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id))
  ));

DROP POLICY IF EXISTS "Users can view visit prefs for events they can see" ON plannen.event_visit_preferences;
CREATE POLICY "Users can view visit prefs for events they can see" ON plannen.event_visit_preferences
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_visit_preferences.event_id
      AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id))
  ));

-- 3. Drop the column (also drops events_shared_with_friends_check).
ALTER TABLE plannen.events DROP COLUMN IF EXISTS shared_with_friends;
