-- Add per-user story sharing — mirror event_shared_with_users so a story
-- can be shared with a specific Plannen user (not just a group).
--
-- Story sharing already supports group sharing via story_shared_with_groups.
-- This adds the second axis so the StoryShareModal has the same dual surface
-- as EventShareModal (groups + selected friends).

CREATE TABLE IF NOT EXISTS plannen.story_shared_with_users (
  story_id uuid NOT NULL REFERENCES plannen.stories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_story_shared_with_users_user_id
  ON plannen.story_shared_with_users (user_id);

ALTER TABLE plannen.story_shared_with_users ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.story_shared_with_users TO anon;
GRANT ALL ON TABLE plannen.story_shared_with_users TO authenticated;
GRANT ALL ON TABLE plannen.story_shared_with_users TO service_role;

-- SECURITY DEFINER helper so the stories RLS can call it without nested RLS.
CREATE OR REPLACE FUNCTION plannen.user_in_story_shared_with_users(p_story_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.story_shared_with_users
    WHERE story_id = p_story_id AND user_id = auth.uid()
  )
$$;

GRANT ALL ON FUNCTION plannen.user_in_story_shared_with_users(uuid) TO anon;
GRANT ALL ON FUNCTION plannen.user_in_story_shared_with_users(uuid) TO authenticated;
GRANT ALL ON FUNCTION plannen.user_in_story_shared_with_users(uuid) TO service_role;

-- Policies on the junction table itself.
DROP POLICY IF EXISTS "Story owners can manage user sharing" ON plannen.story_shared_with_users;
CREATE POLICY "Story owners can manage user sharing" ON plannen.story_shared_with_users
  USING (EXISTS (
    SELECT 1 FROM plannen.stories s
    WHERE s.id = story_shared_with_users.story_id
      AND s.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Recipients can view their story_shared_with_users" ON plannen.story_shared_with_users;
CREATE POLICY "Recipients can view their story_shared_with_users" ON plannen.story_shared_with_users
  FOR SELECT USING (user_id = auth.uid());

-- Extend the stories SELECT policy to include per-user shares. The previous
-- policy from 20260520130000 covered owner + group-share; replace it with one
-- that also covers per-user share.
DROP POLICY IF EXISTS "Group members can view shared stories" ON plannen.stories;
CREATE POLICY "People with whom this story is shared can view it" ON plannen.stories
  FOR SELECT USING (
    user_id <> auth.uid()
    AND (
      plannen.user_in_story_group(stories.id)
      OR plannen.user_in_story_shared_with_users(stories.id)
    )
  );

-- Same for the story_events policy that mirrored the previous one.
DROP POLICY IF EXISTS "Group members can view story_events for shared stories" ON plannen.story_events;
CREATE POLICY "People with whom this story is shared can view story_events"
  ON plannen.story_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM plannen.stories s
      WHERE s.id = story_events.story_id
        AND s.user_id <> auth.uid()
        AND (
          plannen.user_in_story_group(s.id)
          OR plannen.user_in_story_shared_with_users(s.id)
        )
    )
  );
