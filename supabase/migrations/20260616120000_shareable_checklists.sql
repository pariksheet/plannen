-- Shareable checklists: a lean, dateless, agenda-invisible list of checkable
-- items. Deliberately NOT todos (event_kind='todo') — checklist items carry no
-- start_date, no status, no recurrence, and never appear in any briefing /
-- list_events / calendar / gcal / watch query because they live in their own
-- tables that those paths never read. A checklist may attach to a trip
-- container (events.event_kind='container') via event_id (ON DELETE SET NULL —
-- detaching never destroys the list) or stand alone. Items die with their list
-- (CASCADE). Fully collaborative when shared: anyone who can access a list can
-- check/add items; checked_by records who ticked each one.
-- Forward-only; no backfill (no checklists exist yet).

-- ── checklists ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.checklists (
  id          uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  title       text NOT NULL,
  event_id    uuid REFERENCES plannen.events(id) ON DELETE SET NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE plannen.checklists OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklists_created_by ON plannen.checklists (created_by);
CREATE INDEX IF NOT EXISTS idx_checklists_event_id ON plannen.checklists (event_id);

-- ── checklist_items ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.checklist_items (
  id            uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  checklist_id  uuid NOT NULL REFERENCES plannen.checklists(id) ON DELETE CASCADE,
  text          text NOT NULL,
  checked_at    timestamptz,
  checked_by    uuid,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
ALTER TABLE plannen.checklist_items OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist_id
  ON plannen.checklist_items (checklist_id, position);

-- ── sharing junctions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.checklist_shared_with_users (
  checklist_id uuid NOT NULL REFERENCES plannen.checklists(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checklist_id, user_id)
);
ALTER TABLE plannen.checklist_shared_with_users OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklist_shared_with_users_user_id
  ON plannen.checklist_shared_with_users (user_id);

CREATE TABLE IF NOT EXISTS plannen.checklist_shared_with_groups (
  checklist_id uuid NOT NULL REFERENCES plannen.checklists(id) ON DELETE CASCADE,
  group_id     uuid NOT NULL REFERENCES plannen.friend_groups(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checklist_id, group_id)
);
ALTER TABLE plannen.checklist_shared_with_groups OWNER TO postgres;
CREATE INDEX IF NOT EXISTS idx_checklist_shared_with_groups_group_id
  ON plannen.checklist_shared_with_groups (group_id);

-- ── visibility helper (web/Tier-1 RLS path) ───────────────────────────────────
-- Owner OR directly shared OR member of a shared group. SECURITY DEFINER so it
-- reads the sharing tables regardless of the caller's own RLS.
CREATE OR REPLACE FUNCTION plannen.user_can_access_checklist(p_checklist_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = plannen, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM plannen.checklists c
     WHERE c.id = p_checklist_id AND c.created_by = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM plannen.checklist_shared_with_users csu
     WHERE csu.checklist_id = p_checklist_id AND csu.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM plannen.checklist_shared_with_groups csg
      JOIN plannen.friend_group_members fgm ON fgm.group_id = csg.group_id
     WHERE csg.checklist_id = p_checklist_id AND fgm.user_id = auth.uid()
  )
$$;
ALTER FUNCTION plannen.user_can_access_checklist(uuid) OWNER TO postgres;
GRANT ALL ON FUNCTION plannen.user_can_access_checklist(uuid) TO anon;
GRANT ALL ON FUNCTION plannen.user_can_access_checklist(uuid) TO authenticated;
GRANT ALL ON FUNCTION plannen.user_can_access_checklist(uuid) TO service_role;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE plannen.checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE plannen.checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE plannen.checklist_shared_with_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE plannen.checklist_shared_with_groups ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.checklists TO anon, authenticated, service_role;
GRANT ALL ON TABLE plannen.checklist_items TO anon, authenticated, service_role;
GRANT ALL ON TABLE plannen.checklist_shared_with_users TO anon, authenticated, service_role;
GRANT ALL ON TABLE plannen.checklist_shared_with_groups TO anon, authenticated, service_role;

-- checklists: visible to accessors; mutable only by owner.
DROP POLICY IF EXISTS "Accessors can view checklists" ON plannen.checklists;
CREATE POLICY "Accessors can view checklists" ON plannen.checklists
  FOR SELECT USING (plannen.user_can_access_checklist(id));
DROP POLICY IF EXISTS "Owners can insert checklists" ON plannen.checklists;
CREATE POLICY "Owners can insert checklists" ON plannen.checklists
  FOR INSERT WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "Owners can update checklists" ON plannen.checklists;
CREATE POLICY "Owners can update checklists" ON plannen.checklists
  FOR UPDATE USING (created_by = auth.uid());
DROP POLICY IF EXISTS "Owners can delete checklists" ON plannen.checklists;
CREATE POLICY "Owners can delete checklists" ON plannen.checklists
  FOR DELETE USING (created_by = auth.uid());

-- checklist_items: any accessor of the parent list can read AND write.
DROP POLICY IF EXISTS "Accessors can view checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can view checklist_items" ON plannen.checklist_items
  FOR SELECT USING (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can insert checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can insert checklist_items" ON plannen.checklist_items
  FOR INSERT WITH CHECK (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can update checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can update checklist_items" ON plannen.checklist_items
  FOR UPDATE USING (plannen.user_can_access_checklist(checklist_id));
DROP POLICY IF EXISTS "Accessors can delete checklist_items" ON plannen.checklist_items;
CREATE POLICY "Accessors can delete checklist_items" ON plannen.checklist_items
  FOR DELETE USING (plannen.user_can_access_checklist(checklist_id));

-- sharing junctions: owner manages (bare USING also gates INSERT WITH CHECK);
-- the granted party can SELECT the row that grants them access.
DROP POLICY IF EXISTS "Owners manage checklist user-sharing" ON plannen.checklist_shared_with_users;
CREATE POLICY "Owners manage checklist user-sharing" ON plannen.checklist_shared_with_users
  USING (EXISTS (SELECT 1 FROM plannen.checklists c
                 WHERE c.id = checklist_shared_with_users.checklist_id AND c.created_by = auth.uid()));
DROP POLICY IF EXISTS "Shared users see their checklist share" ON plannen.checklist_shared_with_users;
CREATE POLICY "Shared users see their checklist share" ON plannen.checklist_shared_with_users
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Owners manage checklist group-sharing" ON plannen.checklist_shared_with_groups;
CREATE POLICY "Owners manage checklist group-sharing" ON plannen.checklist_shared_with_groups
  USING (EXISTS (SELECT 1 FROM plannen.checklists c
                 WHERE c.id = checklist_shared_with_groups.checklist_id AND c.created_by = auth.uid()));
DROP POLICY IF EXISTS "Group members see checklist group-sharing" ON plannen.checklist_shared_with_groups;
CREATE POLICY "Group members see checklist group-sharing" ON plannen.checklist_shared_with_groups
  FOR SELECT USING (EXISTS (SELECT 1 FROM plannen.friend_group_members fgm
                            WHERE fgm.group_id = checklist_shared_with_groups.group_id
                              AND fgm.user_id = auth.uid()));

COMMENT ON TABLE plannen.checklists IS 'A lean, dateless list of checkable items (packing/shopping/etc). NOT events — never appears in agenda/briefing/list_events. Optionally attached to a trip container via event_id.';
COMMENT ON TABLE plannen.checklist_items IS 'Items of a checklist: text + checkbox + position. checked_by records who ticked it (no FK; app-resolved like assigned_to). CASCADE-deleted with the list.';
