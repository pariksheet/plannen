-- Add the missing SELECT policies on plannen.events for recipients.
--
-- The family-as-group unification (20260520130000_unify_family_as_group.sql)
-- rewrote RLS on event_rsvps + event_memories so they OR-in
-- user_in_event_group(e.id) and user_in_event_shared_with_users(e.id), but
-- did not add the matching SELECT policies on plannen.events itself. Result:
-- a recipient could see the event_shared_with_groups / event_shared_with_users
-- junction rows but the subsequent SELECT against plannen.events returned
-- nothing, leaving MyGroups + MyPeople feeds empty for non-creators.
--
-- This restores symmetry with the existing "Users can view events shared
-- with all friends" policy: each share path (all-friends, group, direct user)
-- gets its own SELECT policy. Helpers used here are SECURITY DEFINER so
-- there is no policy-recursion risk against the events table itself.

DROP POLICY IF EXISTS "Users can view events shared with their groups" ON plannen.events;
CREATE POLICY "Users can view events shared with their groups"
  ON plannen.events
  FOR SELECT
  USING (
    created_by <> auth.uid()
    AND plannen.user_in_event_group(id)
  );

DROP POLICY IF EXISTS "Users can view events shared with them directly" ON plannen.events;
CREATE POLICY "Users can view events shared with them directly"
  ON plannen.events
  FOR SELECT
  USING (
    created_by <> auth.uid()
    AND plannen.user_in_event_shared_with_users(id)
  );
