-- Fix: a group member who can SEE a shared checklist could not add / edit /
-- delete / check its items — writes were silently denied while reads worked.
--
-- Root cause: forward-only migrations are immutable, but an EARLIER, owner-only
-- version of 20260616120000_shareable_checklists.sql was applied to a live DB
-- during feature development, then the file was revised to the collaborative
-- ("any accessor may write") version before the 0.8.0 squash-merge. Because the
-- migration version was already recorded in supabase_migrations, `plannen
-- migrate` skips it, so that DB keeps the original owner-only write policies on
-- plannen.checklist_items: SELECT is accessor-based (reads work) but
-- INSERT/UPDATE/DELETE stayed `created_by = auth.uid()` (writes owner-only).
--
-- Fix: re-assert the intended end-state, idempotently and forward-only.
--  1. Ensure the created_by column exists (mirrors 20260616140000; the web
--     client writes it on insert, so a stale DB missing it fails every add).
--  2. Drop both the canonical accessor names AND the likely legacy owner-only
--     names, then (re)create the collaborative write policies. Permissive
--     policies are OR'd, so this grants access even where a stale DB is correct
--     (harmless no-op) or where an old owner-only policy lingers.
-- No data change.

-- 1. Column (idempotent; matches 20260616140000_checklist_items_created_by).
ALTER TABLE plannen.checklist_items ADD COLUMN IF NOT EXISTS created_by uuid;

-- 2. Collaborative write policies: any accessor of the parent list may write.
-- Drop legacy owner-only variants if a stale DB created them under these names.
DROP POLICY IF EXISTS "Owners can insert checklist_items" ON plannen.checklist_items;
DROP POLICY IF EXISTS "Owners can update checklist_items" ON plannen.checklist_items;
DROP POLICY IF EXISTS "Owners can delete checklist_items" ON plannen.checklist_items;

DROP POLICY IF EXISTS "Accessors can insert checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can insert checklist_items" ON plannen.checklist_items
  FOR INSERT WITH CHECK (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can update checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can update checklist_items" ON plannen.checklist_items
  FOR UPDATE USING (plannen.user_can_access_checklist(checklist_id))
  WITH CHECK (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can delete checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can delete checklist_items" ON plannen.checklist_items
  FOR DELETE USING (plannen.user_can_access_checklist(checklist_id));
