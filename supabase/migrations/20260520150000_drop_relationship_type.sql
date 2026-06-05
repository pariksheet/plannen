-- Drop `relationships.relationship_type` entirely.
--
-- After the family-as-group unification this column is purely cosmetic — the
-- only remaining functional use was the RLS check on
-- `shared_with_friends = 'all'` (filter to relationship_type IN
-- ('friend','both')), and we want that path to mean "all my accepted
-- connections" regardless of how they were originally labelled.
--
-- Forward-only. Existing rows lose their family/friend label; they are still
-- accepted connections so the user gains zero or one connection per row,
-- never loses one.

-- 1. Rewrite RLS so it no longer references relationship_type.
DROP POLICY IF EXISTS "Users can view RSVPs for events they can see" ON plannen.event_rsvps;
CREATE POLICY "Users can view RSVPs for events they can see" ON plannen.event_rsvps
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_rsvps.event_id
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

DROP POLICY IF EXISTS "Users can view memories for events they can see" ON plannen.event_memories;
CREATE POLICY "Users can view memories for events they can see" ON plannen.event_memories
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_memories.event_id
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

DROP POLICY IF EXISTS "Users can view events shared with all friends" ON plannen.events;
CREATE POLICY "Users can view events shared with all friends" ON plannen.events
  FOR SELECT USING (
    shared_with_friends = 'all'
    AND created_by <> auth.uid()
    AND EXISTS (
      SELECT 1 FROM plannen.relationships r
      WHERE r.status = 'accepted'
        AND (
          (r.user_id = auth.uid() AND r.related_user_id = events.created_by)
          OR (r.user_id = events.created_by AND r.related_user_id = auth.uid())
        )
    )
  );

-- 2. Recreate send_relationship_request without the rel_type parameter.
DROP FUNCTION IF EXISTS plannen.send_relationship_request(text, text);
CREATE OR REPLACE FUNCTION plannen.send_relationship_request(target_email text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = plannen, public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_other_id UUID;
  v_rel_id UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT id INTO v_other_id FROM plannen.users WHERE LOWER(TRIM(email)) = LOWER(TRIM(target_email)) LIMIT 1;
  IF v_other_id IS NULL THEN
    RAISE EXCEPTION 'No account found with that email. They need to sign up first.';
  END IF;
  IF v_other_id = v_me THEN
    RAISE EXCEPTION 'You cannot add yourself.';
  END IF;

  INSERT INTO plannen.relationships (user_id, related_user_id, status)
  VALUES (v_me, v_other_id, 'pending')
  ON CONFLICT (user_id, related_user_id) DO UPDATE SET
    status = 'pending',
    updated_at = NOW()
  RETURNING id INTO v_rel_id;
  RETURN v_rel_id;
END;
$$;

GRANT ALL ON FUNCTION plannen.send_relationship_request(text) TO anon;
GRANT ALL ON FUNCTION plannen.send_relationship_request(text) TO authenticated;
GRANT ALL ON FUNCTION plannen.send_relationship_request(text) TO service_role;

-- 3. Recreate get_relationship_requests without the relationship_type column.
DROP FUNCTION IF EXISTS plannen.get_relationship_requests();
CREATE OR REPLACE FUNCTION plannen.get_relationship_requests()
RETURNS TABLE(id uuid, direction text, other_user_id uuid, other_email text, other_name text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = plannen, public
AS $$
  WITH me AS (SELECT auth.uid() AS id),
  received AS (
    SELECT r.id, 'received'::TEXT AS direction, r.user_id AS other_user_id, u.email AS other_email, u.full_name AS other_name, r.created_at
    FROM plannen.relationships r
    JOIN plannen.users u ON u.id = r.user_id
    JOIN me ON me.id = r.related_user_id
    WHERE r.status = 'pending'
  ),
  sent AS (
    SELECT r.id, 'sent'::TEXT AS direction, r.related_user_id AS other_user_id, u.email AS other_email, u.full_name AS other_name, r.created_at
    FROM plannen.relationships r
    JOIN plannen.users u ON u.id = r.related_user_id
    JOIN me ON me.id = r.user_id
    WHERE r.status = 'pending'
  )
  SELECT * FROM received
  UNION ALL
  SELECT * FROM sent;
$$;

GRANT ALL ON FUNCTION plannen.get_relationship_requests() TO anon;
GRANT ALL ON FUNCTION plannen.get_relationship_requests() TO authenticated;
GRANT ALL ON FUNCTION plannen.get_relationship_requests() TO service_role;

-- 4. Drop the column.
ALTER TABLE plannen.relationships DROP CONSTRAINT IF EXISTS relationships_relationship_type_check;
ALTER TABLE plannen.relationships DROP COLUMN IF EXISTS relationship_type;
