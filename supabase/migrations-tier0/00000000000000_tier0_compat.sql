-- Tier 0 compat overlay. Applied BEFORE the main migrations in Tier 0 only.
--
-- Initial schema references Supabase-provided objects (auth.uid, auth.users,
-- storage.buckets/objects) and roles (anon/authenticated/service_role). Tier 1
-- gets those from the GoTrue + Storage stacks; Tier 0 ships these stubs so the
-- initial-schema migration can compile without modification.

-- ---- Roles -----------------------------------------------------------------
-- The grants and OWNER assignments in plannen.* reference these roles. Tier 1
-- gets them from the Supabase image; Tier 0 ships these stubs. Created NOLOGIN
-- as pure permission targets, not login users.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')      THEN CREATE ROLE postgres      NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon          NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role  NOLOGIN; END IF;
END $$;

-- ---- extensions schema ----------------------------------------------------
-- Supabase installs uuid-ossp into a dedicated 'extensions' schema; the dumped
-- table DEFAULTs reference it as extensions.uuid_generate_v4(). Stub it here
-- so initial_schema resolves those references on first apply.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;

-- ---- auth schema -----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

-- auth.uid() returns the per-connection GUC. Tier 1 has the real function from
-- the GoTrue stack; Tier 0 ships this stub.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;

-- auth.users is referenced by the on_auth_user_created trigger. Tier 0 doesn't
-- fire signups through GoTrue, but the schema reference must resolve. Bootstrap
-- inserts the single user row directly into plannen.users (skipping the
-- trigger). Columns mirror the Supabase shape that handle_new_user reads.
CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text UNIQUE,
  raw_user_meta_data  jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---- storage schema --------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id     text PRIMARY KEY,
  name   text,
  public boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS storage.objects (
  bucket_id  text NOT NULL,
  name       text NOT NULL,
  owner      uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata   jsonb,
  PRIMARY KEY (bucket_id, name)
);

-- The initial_schema's storage policies reference 'authenticated' role.
-- That role exists from the block above, so the CREATE POLICY blocks succeed.
