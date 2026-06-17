-- Unified event sharing: one table, one level, plus a per-recipient adoption
-- inbox and a global default-share rule. Forward-only. Old junctions
-- (event_shared_with_groups/users) + events.shared_with_friends stay present
-- but read-dormant after this migration repoints the RLS helpers; a later
-- migration drops them.

-- 1. Tables -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plannen.event_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES plannen.events(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('user','group','all')),
  target_id   uuid,
  level       text NOT NULL DEFAULT 'awareness' CHECK (level IN ('awareness','assigned')),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_shares_target_id_shape CHECK (
    (target_type = 'all' AND target_id IS NULL)
    OR (target_type IN ('user','group') AND target_id IS NOT NULL)
  ),
  UNIQUE (event_id, target_type, target_id)
);
-- NULLs are distinct in UNIQUE, so guard the single 'all' row separately.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_shares_all
  ON plannen.event_shares (event_id) WHERE target_type = 'all';
CREATE INDEX IF NOT EXISTS idx_event_shares_event   ON plannen.event_shares (event_id);
CREATE INDEX IF NOT EXISTS idx_event_shares_target  ON plannen.event_shares (target_type, target_id);

ALTER TABLE plannen.event_shares ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE plannen.event_shares TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS plannen.event_share_adoption (
  event_id   uuid NOT NULL REFERENCES plannen.events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
ALTER TABLE plannen.event_share_adoption ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE plannen.event_share_adoption TO anon, authenticated, service_role;

-- 2. Default-share rule on user_settings ------------------------------------
ALTER TABLE plannen.user_settings
  ADD COLUMN IF NOT EXISTS default_share_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_share_target_type text
    CHECK (default_share_target_type IN ('user','group','all')),
  ADD COLUMN IF NOT EXISTS default_share_target_id uuid,
  ADD COLUMN IF NOT EXISTS default_share_level text NOT NULL DEFAULT 'awareness'
    CHECK (default_share_level = 'awareness');

-- 3. Backfill from the old sources, all at level 'awareness' -----------------
INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by, created_at)
SELECT esg.event_id, 'group', esg.group_id, 'awareness', e.created_by, esg.created_at
  FROM plannen.event_shared_with_groups esg
  JOIN plannen.events e ON e.id = esg.event_id
ON CONFLICT DO NOTHING;

INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by, created_at)
SELECT esu.event_id, 'user', esu.user_id, 'awareness', e.created_by, esu.created_at
  FROM plannen.event_shared_with_users esu
  JOIN plannen.events e ON e.id = esu.event_id
ON CONFLICT DO NOTHING;

INSERT INTO plannen.event_shares (event_id, target_type, target_id, level, created_by, created_at)
SELECT e.id, 'all', NULL, 'awareness', e.created_by, now()
  FROM plannen.events e
 WHERE e.shared_with_friends = 'all'
ON CONFLICT DO NOTHING;

-- 4. Unified visibility helper (SECURITY DEFINER -> no policy recursion) -----
CREATE OR REPLACE FUNCTION plannen.user_can_see_event(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = plannen, public
AS $$
  WITH me AS (SELECT auth.uid() AS uid)
  SELECT EXISTS (
    -- direct shares on the event, or shares on the event's container (trip branch)
    SELECT 1
      FROM plannen.event_shares s
      JOIN plannen.events e ON e.id = p_event_id
     WHERE (s.event_id = p_event_id OR s.event_id = e.group_id)
       AND (
            (s.target_type = 'user'  AND s.target_id = (SELECT uid FROM me))
         OR (s.target_type = 'group' AND EXISTS (
               SELECT 1 FROM plannen.friend_group_members fgm
                WHERE fgm.group_id = s.target_id AND fgm.user_id = (SELECT uid FROM me)))
         OR (s.target_type = 'all'   AND EXISTS (
               SELECT 1 FROM plannen.relationships r
                WHERE r.status = 'accepted'
                  AND ((r.user_id = (SELECT uid FROM me) AND r.related_user_id = s.created_by)
                    OR (r.user_id = s.created_by AND r.related_user_id = (SELECT uid FROM me)))))
       )
  )
$$;
GRANT ALL ON FUNCTION plannen.user_can_see_event(uuid) TO anon, authenticated, service_role;

-- Repoint legacy helpers at event_shares so existing rsvps/memories policies
-- that call them keep working off the new source (old junctions now dormant).
CREATE OR REPLACE FUNCTION plannen.user_in_event_group(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.event_shares s
      JOIN plannen.friend_group_members fgm ON fgm.group_id = s.target_id
     WHERE s.event_id = p_event_id AND s.target_type = 'group'
       AND fgm.user_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION plannen.user_in_event_shared_with_users(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.event_shares s
     WHERE s.event_id = p_event_id AND s.target_type = 'user'
       AND s.target_id = auth.uid()
  )
$$;

-- 5. Collapse the events SELECT share-policies into one ----------------------
DROP POLICY IF EXISTS "Users can view events shared with their groups" ON plannen.events;
DROP POLICY IF EXISTS "Users can view events shared with them directly" ON plannen.events;
DROP POLICY IF EXISTS "Users can view events shared with all friends" ON plannen.events;
DROP POLICY IF EXISTS "Users can view shared events" ON plannen.events;
CREATE POLICY "Users can view shared events"
  ON plannen.events FOR SELECT
  USING (created_by <> auth.uid() AND plannen.user_can_see_event(id));

-- 6. event_shares policies: readable if you can see the parent event; only the
--    event creator may mutate shares.
DROP POLICY IF EXISTS "View shares for visible events" ON plannen.event_shares;
CREATE POLICY "View shares for visible events" ON plannen.event_shares
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM plannen.events e
             WHERE e.id = event_shares.event_id
               AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id)))
  );
DROP POLICY IF EXISTS "Event creator manages shares" ON plannen.event_shares;
CREATE POLICY "Event creator manages shares" ON plannen.event_shares
  FOR ALL USING (
    EXISTS (SELECT 1 FROM plannen.events e
             WHERE e.id = event_shares.event_id AND e.created_by = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM plannen.events e
             WHERE e.id = event_shares.event_id AND e.created_by = auth.uid())
  );

-- 7. adoption policies: a user manages only their own rows, for events they see.
DROP POLICY IF EXISTS "Users manage own adoption" ON plannen.event_share_adoption;
CREATE POLICY "Users manage own adoption" ON plannen.event_share_adoption
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid()
    AND (EXISTS (SELECT 1 FROM plannen.events e
                  WHERE e.id = event_share_adoption.event_id
                    AND (e.created_by = auth.uid() OR plannen.user_can_see_event(e.id)))));

-- 8. complete_event RPC: creator OR an 'assigned'-level recipient may flip
--    completion. No broad assignee UPDATE grant on events.
CREATE OR REPLACE FUNCTION plannen.complete_event(p_event_id uuid, p_done boolean DEFAULT true)
RETURNS plannen.events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = plannen, public
AS $$
DECLARE r plannen.events;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM plannen.events e WHERE e.id = p_event_id AND e.created_by = auth.uid()
  ) AND NOT EXISTS (
    SELECT 1 FROM plannen.event_shares s
     WHERE s.event_id = p_event_id AND s.level = 'assigned'
       AND ((s.target_type = 'user'  AND s.target_id = auth.uid())
         OR (s.target_type = 'group' AND EXISTS (
               SELECT 1 FROM plannen.friend_group_members fgm
                WHERE fgm.group_id = s.target_id AND fgm.user_id = auth.uid())))
  ) THEN
    RAISE EXCEPTION 'not allowed to complete this event';
  END IF;
  UPDATE plannen.events
     SET completed_at = CASE WHEN p_done THEN now() ELSE NULL END
   WHERE id = p_event_id
  RETURNING * INTO r;
  RETURN r;
END;
$$;
GRANT EXECUTE ON FUNCTION plannen.complete_event(uuid, boolean) TO anon, authenticated, service_role;
