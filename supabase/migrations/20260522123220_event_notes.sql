-- event_notes: free-text observations attached to an event by any user who can
-- see it. Each user can write multiple notes per event. RLS mirrors
-- event_memories: SELECT delegates to event visibility; INSERT/UPDATE/DELETE
-- are author-scoped.

CREATE TABLE IF NOT EXISTS plannen.event_notes (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  event_id uuid NOT NULL REFERENCES plannen.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_notes_event_id ON plannen.event_notes(event_id);
CREATE INDEX IF NOT EXISTS idx_event_notes_user_id ON plannen.event_notes(user_id);

ALTER TABLE plannen.event_notes ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.event_notes TO anon;
GRANT ALL ON TABLE plannen.event_notes TO authenticated;
GRANT ALL ON TABLE plannen.event_notes TO service_role;

-- SELECT: anyone who can see the parent event. Mirrors the visibility
-- expression used by event_memories.
DROP POLICY IF EXISTS "Users can view notes for events they can see" ON plannen.event_notes;
CREATE POLICY "Users can view notes for events they can see" ON plannen.event_notes
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_notes.event_id
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

DROP POLICY IF EXISTS "Users can insert own notes" ON plannen.event_notes;
CREATE POLICY "Users can insert own notes" ON plannen.event_notes
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own notes" ON plannen.event_notes;
CREATE POLICY "Users can update own notes" ON plannen.event_notes
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own notes" ON plannen.event_notes;
CREATE POLICY "Users can delete own notes" ON plannen.event_notes
  FOR DELETE USING (user_id = auth.uid());

-- Auto-touch updated_at on UPDATE (small trigger).
CREATE OR REPLACE FUNCTION plannen.event_notes_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_notes_updated_at ON plannen.event_notes;
CREATE TRIGGER trg_event_notes_updated_at
  BEFORE UPDATE ON plannen.event_notes
  FOR EACH ROW
  EXECUTE FUNCTION plannen.event_notes_set_updated_at();

GRANT ALL ON FUNCTION plannen.event_notes_set_updated_at() TO anon;
GRANT ALL ON FUNCTION plannen.event_notes_set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION plannen.event_notes_set_updated_at() TO service_role;
