-- Fix a pre-existing RLS recursion between friend_groups and
-- friend_group_members.
--
-- Cycle:
--   SELECT FROM friend_groups
--     -> policy "Members can view their groups"
--        -> EXISTS (SELECT 1 FROM friend_group_members ...)
--           -> friend_group_members RLS fires
--              -> policy "Group owners can manage members"
--                 -> EXISTS (SELECT 1 FROM friend_groups ...)   -- RECURSES
--
-- Postgres detects this with `42P17 infinite recursion detected in policy`
-- the moment we try to read friend_groups as a normal user.
--
-- Fix: replace the offending sub-select with a SECURITY DEFINER helper that
-- bypasses RLS internally. Policy bodies that call the helper no longer
-- re-enter friend_groups via RLS.

CREATE OR REPLACE FUNCTION plannen.user_owns_friend_group(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.friend_groups fg
    WHERE fg.id = p_group_id
      AND fg.created_by = auth.uid()
  )
$$;

GRANT ALL ON FUNCTION plannen.user_owns_friend_group(uuid) TO anon;
GRANT ALL ON FUNCTION plannen.user_owns_friend_group(uuid) TO authenticated;
GRANT ALL ON FUNCTION plannen.user_owns_friend_group(uuid) TO service_role;

-- Replace the recursive "Group owners can manage members" policy on
-- friend_group_members with one that goes through the helper.
DROP POLICY IF EXISTS "Group owners can manage members" ON plannen.friend_group_members;
CREATE POLICY "Group owners can manage members" ON plannen.friend_group_members
  USING (plannen.user_owns_friend_group(group_id))
  WITH CHECK (plannen.user_owns_friend_group(group_id));

-- Same fix for the event_shared_with_groups "Group owners can view ..." and
-- "Event creators can manage group sharing" policies — those also subselect
-- friend_groups/events and could recurse via similar cycles. The events
-- policy stays as-is (events doesn't trigger the cycle today), but the
-- friend_groups one is the lurking risk.
DROP POLICY IF EXISTS "Group owners can view event_shared_with_groups" ON plannen.event_shared_with_groups;
CREATE POLICY "Group owners can view event_shared_with_groups" ON plannen.event_shared_with_groups
  FOR SELECT USING (plannen.user_owns_friend_group(group_id));

-- Apply the same hardening to the story_shared_with_groups policy added in
-- the previous migration.
DROP POLICY IF EXISTS "Group owners can view story_shared_with_groups" ON plannen.story_shared_with_groups;
CREATE POLICY "Group owners can view story_shared_with_groups" ON plannen.story_shared_with_groups
  FOR SELECT USING (plannen.user_owns_friend_group(group_id));
