-- Fix: creating a checklist from the web client failed with
--   42501: new row violates row-level security policy for table "checklists"
--
-- Root cause: the SELECT policy "Accessors can view checklists" gated visibility
-- solely through plannen.user_can_access_checklist(id), which re-queries
-- plannen.checklists BY id. The web client inserts with return=representation
-- (PostgREST .select() after insert), so PostgreSQL applies the SELECT policy to
-- the just-inserted row via INSERT ... RETURNING. A command cannot see its own
-- newly-inserted row, so the self-referential lookup returned false and RETURNING
-- was denied — even though the INSERT WITH CHECK (created_by = auth.uid()) passed.
-- (The events table never hit this because its SELECT policy checks
-- created_by = auth.uid() directly on the row, not via a self-query.)
--
-- Fix: add a direct owner branch evaluated on the row itself. Owners already may
-- see their own checklists — this just makes that check visible during RETURNING.
-- Shared access still flows through user_can_access_checklist(). No data change.
DROP POLICY IF EXISTS "Accessors can view checklists" ON plannen.checklists;
CREATE POLICY "Accessors can view checklists" ON plannen.checklists
  FOR SELECT USING (created_by = auth.uid() OR plannen.user_can_access_checklist(id));
