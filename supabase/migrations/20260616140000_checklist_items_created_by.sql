-- Track who ADDED each checklist item (distinct from checked_by, who ticked it).
-- Nullable, no FK (app-resolved like checked_by/assigned_to), no backfill —
-- pre-existing items keep created_by = NULL and render as an unknown author.
-- Any accessor of the parent list may add items, so this records the adder.
ALTER TABLE plannen.checklist_items ADD COLUMN IF NOT EXISTS created_by uuid;
COMMENT ON COLUMN plannen.checklist_items.created_by IS 'Who added the item (app-resolved, no FK). NULL for items created before this column existed.';
