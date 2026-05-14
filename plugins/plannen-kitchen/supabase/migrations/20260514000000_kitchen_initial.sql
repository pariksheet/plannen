-- plannen-kitchen — initial schema.
--
-- Adds the `kitchen` Postgres schema with three tables (stores, lists, items)
-- and one view (pantry). RLS is intentionally not enabled — Plannen is single-
-- user local, same posture as `plannen.*`.
--
-- Forward-only. Never edit this file in place; add a new timestamped migration
-- on top.

CREATE SCHEMA IF NOT EXISTS "kitchen";
ALTER SCHEMA "kitchen" OWNER TO "postgres";
COMMENT ON SCHEMA "kitchen" IS 'plannen-kitchen plugin schema — grocery lists, items, stores, pantry view.';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.stores
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen.stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('supermarket','bakery','local','online','other')),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.stores IS 'Stores where items are bought. Free-form name; type controlled.';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.lists
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen.lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  week_of    date,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.lists IS 'A weekly (or one-off) shopping list. status=active is the current one in flight.';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.items
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE kitchen.items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id    uuid NOT NULL REFERENCES kitchen.lists(id) ON DELETE CASCADE,
  name       text NOT NULL,
  qty        text,
  store_id   uuid REFERENCES kitchen.stores(id) ON DELETE SET NULL,
  aisle      text,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','skipped')),
  picked_at  timestamptz,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kitchen.items IS 'One row per item on a list. status=picked + picked_at feed the pantry view.';

-- ──────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ──────────────────────────────────────────────────────────────────────────────

CREATE INDEX items_list_id_status     ON kitchen.items(list_id, status);
CREATE INDEX items_name_picked_at     ON kitchen.items(lower(name), picked_at DESC) WHERE status = 'picked';
CREATE INDEX items_picked_at          ON kitchen.items(picked_at DESC)              WHERE status = 'picked';

-- ──────────────────────────────────────────────────────────────────────────────
-- kitchen.pantry view
-- ──────────────────────────────────────────────────────────────────────────────

CREATE VIEW kitchen.pantry AS
  SELECT
    i.id,
    i.name,
    i.qty,
    i.store_id,
    s.name      AS store_name,
    i.picked_at,
    (now() - i.picked_at) AS age
  FROM kitchen.items i
  LEFT JOIN kitchen.stores s ON s.id = i.store_id
  WHERE i.status = 'picked' AND i.picked_at IS NOT NULL
  ORDER BY i.picked_at DESC;

COMMENT ON VIEW kitchen.pantry IS 'Derived: items marked picked, ordered by most-recently-bought. age is now()-picked_at.';

-- ──────────────────────────────────────────────────────────────────────────────
-- API exposure for PostgREST (so the Supabase JS client can hit kitchen.* from
-- the web UI with the anon key). The MCP server uses the service-role key and
-- doesn't depend on this.
-- ──────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA kitchen TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA kitchen TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA kitchen TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA kitchen GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA kitchen GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
