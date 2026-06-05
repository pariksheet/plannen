-- Add a per-user "primary group" pointer so the UI can pin one group's
-- shared events to the navigation, immediately before "My Groups".
--
-- ON DELETE SET NULL: deleting the group quietly clears the pin instead of
-- cascading and stranding the user with a broken nav tab.
--
-- Auto-promotion (set the column on first-group-create when it's still NULL)
-- happens in the app's createGroup() path, not via a trigger — keeps the
-- behaviour readable and easy to change.

ALTER TABLE plannen.users
  ADD COLUMN IF NOT EXISTS primary_group_id uuid NULL
    REFERENCES plannen.friend_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_primary_group_id
  ON plannen.users(primary_group_id);
