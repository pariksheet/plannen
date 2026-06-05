-- Unify family sharing into the existing group machinery.
--
-- Before: events and stories carried a `shared_with_family` boolean. RLS
-- compared it against `relationships.relationship_type='family'`. Friend
-- groups already had a generic share path via event_shared_with_groups.
--
-- After: there is one share path — group membership. "Family" is not a
-- system concept anymore; it's just a group the user can create and name
-- whatever they like. Stories get a `story_shared_with_groups` junction
-- that mirrors the events one. Daily-briefing context can be tuned via
-- `user_profiles.primary_circle_group_ids` (an array of group ids whose
-- members are merged into the briefing's "circle" alongside family_members).
--
-- This is forward-only and intentionally does not preserve any existing
-- shared_with_family=true rows: the project has a single user today and no
-- shared events worth preserving.

-- 1. Add primary_circle_group_ids to user_profiles. Empty default = behave
--    exactly like before (briefing reads family_members only).
ALTER TABLE plannen.user_profiles
  ADD COLUMN IF NOT EXISTS primary_circle_group_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- 2. Mirror event_shared_with_groups for stories.
CREATE TABLE IF NOT EXISTS plannen.story_shared_with_groups (
  story_id uuid NOT NULL REFERENCES plannen.stories(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES plannen.friend_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_story_shared_with_groups_group_id
  ON plannen.story_shared_with_groups (group_id);

ALTER TABLE plannen.story_shared_with_groups ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.story_shared_with_groups TO anon;
GRANT ALL ON TABLE plannen.story_shared_with_groups TO authenticated;
GRANT ALL ON TABLE plannen.story_shared_with_groups TO service_role;

DROP POLICY IF EXISTS "Story owners can manage group sharing" ON plannen.story_shared_with_groups;
CREATE POLICY "Story owners can manage group sharing" ON plannen.story_shared_with_groups
  USING (EXISTS (
    SELECT 1 FROM plannen.stories s
    WHERE s.id = story_shared_with_groups.story_id
      AND s.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Group members can view story_shared_with_groups" ON plannen.story_shared_with_groups;
CREATE POLICY "Group members can view story_shared_with_groups" ON plannen.story_shared_with_groups
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.friend_group_members fgm
    WHERE fgm.group_id = story_shared_with_groups.group_id
      AND fgm.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Group owners can view story_shared_with_groups" ON plannen.story_shared_with_groups;
CREATE POLICY "Group owners can view story_shared_with_groups" ON plannen.story_shared_with_groups
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.friend_groups fg
    WHERE fg.id = story_shared_with_groups.group_id
      AND fg.created_by = auth.uid()
  ));

-- 3. Helper: a user can view an event via group membership.
CREATE OR REPLACE FUNCTION plannen.user_in_event_group(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM plannen.event_shared_with_groups esg
      JOIN plannen.friend_group_members fgm ON fgm.group_id = esg.group_id
     WHERE esg.event_id = p_event_id
       AND fgm.user_id = auth.uid()
  )
$$;

GRANT ALL ON FUNCTION plannen.user_in_event_group(uuid) TO anon;
GRANT ALL ON FUNCTION plannen.user_in_event_group(uuid) TO authenticated;
GRANT ALL ON FUNCTION plannen.user_in_event_group(uuid) TO service_role;

CREATE OR REPLACE FUNCTION plannen.user_in_story_group(p_story_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM plannen.story_shared_with_groups ssg
      JOIN plannen.friend_group_members fgm ON fgm.group_id = ssg.group_id
     WHERE ssg.story_id = p_story_id
       AND fgm.user_id = auth.uid()
  )
$$;

GRANT ALL ON FUNCTION plannen.user_in_story_group(uuid) TO anon;
GRANT ALL ON FUNCTION plannen.user_in_story_group(uuid) TO authenticated;
GRANT ALL ON FUNCTION plannen.user_in_story_group(uuid) TO service_role;

-- 4. Rewrite RLS policies that reference shared_with_family before dropping
--    the column.

-- event_rsvps: visible if user owns the event, was personally invited,
-- the event is shared with a group the user belongs to, or shared_with_friends='all'.
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
              AND r.relationship_type = ANY (ARRAY['friend','both'])
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
              AND r.relationship_type = ANY (ARRAY['friend','both'])
              AND (
                (r.user_id = auth.uid() AND r.related_user_id = e.created_by)
                OR (r.user_id = e.created_by AND r.related_user_id = auth.uid())
              )
          )
        )
      )
  ));

-- Drop the old story policies that compared shared_with_family.
DROP POLICY IF EXISTS "Family can view shared stories" ON plannen.stories;
DROP POLICY IF EXISTS "Family can view story_events for shared stories" ON plannen.story_events;

CREATE POLICY "Group members can view shared stories" ON plannen.stories
  FOR SELECT USING (
    user_id <> auth.uid()
    AND plannen.user_in_story_group(stories.id)
  );

CREATE POLICY "Group members can view story_events for shared stories"
  ON plannen.story_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM plannen.stories s
      WHERE s.id = story_events.story_id
        AND s.user_id <> auth.uid()
        AND plannen.user_in_story_group(s.id)
    )
  );

-- 5. Drop the now-unused shared_with_family columns.
DROP INDEX IF EXISTS plannen.idx_stories_shared_with_family;
ALTER TABLE plannen.stories DROP COLUMN IF EXISTS shared_with_family;
ALTER TABLE plannen.events DROP COLUMN IF EXISTS shared_with_family;
