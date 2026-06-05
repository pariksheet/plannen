-- Add family-share to stories so linked family members can read each other's
-- stories. Mirrors plannen.events.shared_with_family. Friends-share is left
-- out for now; can be added with the same shape when needed.

ALTER TABLE plannen.stories
  ADD COLUMN IF NOT EXISTS shared_with_family boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_stories_shared_with_family
  ON plannen.stories (shared_with_family)
  WHERE shared_with_family = true;

-- New SELECT policy: a story is readable by an accepted family member when
-- shared_with_family is true. The existing "Users can view own stories"
-- policy continues to cover the owner.
DROP POLICY IF EXISTS "Family can view shared stories" ON plannen.stories;
CREATE POLICY "Family can view shared stories" ON plannen.stories
  FOR SELECT
  USING (
    shared_with_family
    AND user_id <> auth.uid()
    AND EXISTS (
      SELECT 1 FROM plannen.relationships r
      WHERE r.status = 'accepted'
        AND r.relationship_type = ANY (ARRAY['family', 'both'])
        AND (
          (r.user_id = auth.uid() AND r.related_user_id = stories.user_id)
          OR (r.user_id = stories.user_id AND r.related_user_id = auth.uid())
        )
    )
  );

-- story_events join rows must also be visible to family readers so the linked
-- event titles render in the StoryReader header.
DROP POLICY IF EXISTS "Family can view story_events for shared stories" ON plannen.story_events;
CREATE POLICY "Family can view story_events for shared stories" ON plannen.story_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM plannen.stories s
      WHERE s.id = story_events.story_id
        AND s.shared_with_family
        AND s.user_id <> auth.uid()
        AND EXISTS (
          SELECT 1 FROM plannen.relationships r
          WHERE r.status = 'accepted'
            AND r.relationship_type = ANY (ARRAY['family', 'both'])
            AND (
              (r.user_id = auth.uid() AND r.related_user_id = s.user_id)
              OR (r.user_id = s.user_id AND r.related_user_id = auth.uid())
            )
        )
    )
  );
