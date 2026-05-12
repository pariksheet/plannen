-- Plannen — consolidated initial schema.
--
-- This file replaces 41 chronological migrations that landed between the
-- project's first commit and the 2026-05-12 open-source-prep squash. The
-- contents are the cumulative state captured via:
--
--   supabase db dump --local --schema public
--
-- plus the auth.users → public.handle_new_user trigger and the event-photos
-- storage bucket + policies that previously lived in their own migrations
-- (auth and storage schemas, not captured by a public-schema dump).
--
-- For an existing dev DB carrying the old migration history: after pulling
-- this commit, mark this version applied (the schema already exists) with:
--
--   supabase migration repair --status applied 00000000000000 --local
--
-- For a fresh clone: bootstrap.sh + supabase migration up applies it cleanly.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- public schema (dumped 2026-05-12)
-- ============================================================================




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."accept_relationship"("rel_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  UPDATE public.relationships
  SET status = 'accepted', updated_at = NOW()
  WHERE id = rel_id AND related_user_id = v_me AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found or already handled';
  END IF;
END;
$$;


ALTER FUNCTION "public"."accept_relationship"("rel_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_trigger_func"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_row_id TEXT;
BEGIN
  -- Avoid RECORD IS NOT NULL checks on unassigned variables by using TG_OP directly
  v_row_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.id::TEXT
    WHEN TG_OP = 'INSERT' THEN NEW.id::TEXT
    WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.id::TEXT, NEW.id::TEXT)
    ELSE NULL
  END;

  INSERT INTO public.audit_log (schema_name, table_name, operation, row_id, actor_role, actor_uid)
  VALUES (
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    TG_OP,
    v_row_id,
    current_user,
    auth.uid()
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;


ALTER FUNCTION "public"."audit_trigger_func"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decline_relationship"("rel_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  UPDATE public.relationships
  SET status = 'blocked', updated_at = NOW()
  WHERE id = rel_id AND (related_user_id = v_me OR user_id = v_me) AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found or already handled';
  END IF;
END;
$$;


ALTER FUNCTION "public"."decline_relationship"("rel_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_invite_by_token"("invite_token" "text") RETURNS TABLE("event_id" "uuid", "event_title" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT e.id AS event_id, e.title AS event_title
  FROM public.event_invites i
  JOIN public.events e ON e.id = i.event_id
  WHERE i.token = TRIM(invite_token)
    AND (i.expires_at IS NULL OR i.expires_at > NOW());
END;
$$;


ALTER FUNCTION "public"."get_invite_by_token"("invite_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_relationship_requests"() RETURNS TABLE("id" "uuid", "direction" "text", "relationship_type" "text", "other_user_id" "uuid", "other_email" "text", "other_name" "text", "created_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH me AS (SELECT auth.uid() AS id),
  received AS (
    SELECT r.id, 'received'::TEXT AS direction, r.relationship_type, r.user_id AS other_user_id, u.email AS other_email, u.full_name AS other_name, r.created_at
    FROM public.relationships r
    JOIN public.users u ON u.id = r.user_id
    JOIN me ON me.id = r.related_user_id
    WHERE r.status = 'pending'
  ),
  sent AS (
    SELECT r.id, 'sent'::TEXT AS direction, r.relationship_type, r.related_user_id AS other_user_id, u.email AS other_email, u.full_name AS other_name, r.created_at
    FROM public.relationships r
    JOIN public.users u ON u.id = r.related_user_id
    JOIN me ON me.id = r.user_id
    WHERE r.status = 'pending'
  )
  SELECT * FROM received
  UNION ALL
  SELECT * FROM sent
  ORDER BY created_at DESC;
$$;


ALTER FUNCTION "public"."get_relationship_requests"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, avatar_url)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'avatar_url')
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, users.full_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
    updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_event_by_invite"("invite_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_event_id UUID;
  v_shared_with_friends TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT i.event_id INTO v_event_id
  FROM public.event_invites i
  WHERE i.token = TRIM(invite_token)
    AND (i.expires_at IS NULL OR i.expires_at > NOW());

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'Invalid or expired invite';
  END IF;

  INSERT INTO public.event_shared_with_users (event_id, user_id)
  VALUES (v_event_id, v_user_id)
  ON CONFLICT (event_id, user_id) DO NOTHING;

  SELECT e.shared_with_friends INTO v_shared_with_friends
  FROM public.events e WHERE e.id = v_event_id;

  IF v_shared_with_friends = 'none' THEN
    UPDATE public.events SET shared_with_friends = 'selected' WHERE id = v_event_id;
  END IF;

  RETURN v_event_id;
END;
$$;


ALTER FUNCTION "public"."join_event_by_invite"("invite_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_relationship_request"("target_email" "text", "rel_type" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_me UUID := auth.uid();
  v_other_id UUID;
  v_rel_id UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF rel_type IS NULL OR rel_type NOT IN ('friend', 'family', 'both') THEN
    RAISE EXCEPTION 'Invalid relationship type';
  END IF;

  SELECT id INTO v_other_id FROM public.users WHERE LOWER(TRIM(email)) = LOWER(TRIM(target_email)) LIMIT 1;
  IF v_other_id IS NULL THEN
    RAISE EXCEPTION 'No account found with that email. They need to sign up first.';
  END IF;
  IF v_other_id = v_me THEN
    RAISE EXCEPTION 'You cannot add yourself.';
  END IF;

  INSERT INTO public.relationships (user_id, related_user_id, relationship_type, status)
  VALUES (v_me, v_other_id, rel_type, 'pending')
  ON CONFLICT (user_id, related_user_id) DO UPDATE SET
    relationship_type = EXCLUDED.relationship_type,
    status = 'pending',
    updated_at = NOW()
  RETURNING id INTO v_rel_id;
  RETURN v_rel_id;
END;
$$;


ALTER FUNCTION "public"."send_relationship_request"("target_email" "text", "rel_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_stories_edited_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := NOW();
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_stories_edited_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_in_event_shared_with_groups"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.event_shared_with_groups esg
    JOIN public.friend_group_members fgm ON fgm.group_id = esg.group_id
    WHERE esg.event_id = p_event_id AND fgm.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."user_in_event_shared_with_groups"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_in_event_shared_with_users"("p_event_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.event_shared_with_users
    WHERE event_id = p_event_id AND user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."user_in_event_shared_with_users"("p_event_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_settings_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."user_settings_set_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_tasks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "task_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "next_check" timestamp with time zone,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_checked_at" timestamp with time zone,
    "last_result" "jsonb",
    "last_page_hash" "text",
    "fail_count" integer DEFAULT 0 NOT NULL,
    "has_unread_update" boolean DEFAULT false NOT NULL,
    "update_summary" "text",
    "recurrence_months" integer,
    "last_occurrence_date" "date",
    CONSTRAINT "agent_tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'completed'::"text", 'failed'::"text"]))),
    CONSTRAINT "agent_tasks_task_type_check" CHECK (("task_type" = ANY (ARRAY['enrollment_monitor'::"text", 'recurring_check'::"text", 'scrape_url'::"text"])))
);


ALTER TABLE "public"."agent_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_allowed_emails" (
    "email" "text" NOT NULL,
    "invited_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."app_allowed_emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "schema_name" "text" NOT NULL,
    "table_name" "text" NOT NULL,
    "operation" "text" NOT NULL,
    "row_id" "text",
    "actor_role" "text",
    "actor_uid" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "audit_log_operation_check" CHECK (("operation" = ANY (ARRAY['INSERT'::"text", 'UPDATE'::"text", 'DELETE'::"text"])))
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."audit_log" IS 'DML audit trail for sensitive tables; actor_role is current_user (service_role vs anon/authenticated in Supabase).';



CREATE TABLE IF NOT EXISTS "public"."event_invites" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."event_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_memories" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "media_url" "text",
    "caption" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "source" "text" DEFAULT 'upload'::"text" NOT NULL,
    "external_id" "text",
    "taken_at" timestamp with time zone,
    "media_type" "text" DEFAULT 'image'::"text" NOT NULL,
    "transcript" "text",
    "transcript_lang" "text",
    "transcribed_at" timestamp with time zone,
    CONSTRAINT "event_memories_media_type_check" CHECK (("media_type" = ANY (ARRAY['image'::"text", 'video'::"text", 'audio'::"text"]))),
    CONSTRAINT "event_memories_source_check" CHECK (("source" = ANY (ARRAY['upload'::"text", 'google_drive'::"text", 'google_photos'::"text"])))
);


ALTER TABLE "public"."event_memories" OWNER TO "postgres";


COMMENT ON COLUMN "public"."event_memories"."media_url" IS 'Public URL to media in the event-photos bucket. Bucket name is historical — it now holds image, video, and audio. See media_type for the kind.';



COMMENT ON COLUMN "public"."event_memories"."source" IS 'upload = stored in our storage; google_drive/google_photos = proxy via owner token';



COMMENT ON COLUMN "public"."event_memories"."external_id" IS 'Provider file id (Drive file_id or Photos media_item_id)';



COMMENT ON COLUMN "public"."event_memories"."transcript" IS 'Auto-generated transcript from whisper.cpp for audio memories. NULL means not yet transcribed (or whisper not installed when the user invoked story generation). caption remains the user-editable field.';



CREATE TABLE IF NOT EXISTS "public"."event_rsvps" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'maybe'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "preferred_visit_date" timestamp with time zone,
    CONSTRAINT "event_rsvps_status_check" CHECK (("status" = ANY (ARRAY['going'::"text", 'maybe'::"text", 'not_going'::"text"])))
);


ALTER TABLE "public"."event_rsvps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_shared_with_groups" (
    "event_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."event_shared_with_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_shared_with_users" (
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."event_shared_with_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_source_refs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ref_type" "text" DEFAULT 'enrollment_url'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."event_source_refs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_sources" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "source_url" "text" NOT NULL,
    "name" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source_type" "text",
    "last_analysed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "event_sources_source_type_check" CHECK (("source_type" = ANY (ARRAY['platform'::"text", 'organiser'::"text", 'one_off'::"text"])))
);


ALTER TABLE "public"."event_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "start_date" timestamp with time zone NOT NULL,
    "end_date" timestamp with time zone,
    "enrollment_url" "text",
    "enrollment_deadline" timestamp with time zone,
    "event_type" "text" DEFAULT 'personal'::"text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "event_status" "text" DEFAULT 'upcoming'::"text",
    "image_url" "text",
    "event_kind" "text" DEFAULT 'event'::"text" NOT NULL,
    "enrollment_start_date" timestamp with time zone,
    "shared_with_family" boolean DEFAULT false NOT NULL,
    "shared_with_friends" "text" DEFAULT 'none'::"text" NOT NULL,
    "location" "text",
    "hashtags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "recurrence_rule" "jsonb",
    "parent_event_id" "uuid",
    "gcal_event_id" "text",
    CONSTRAINT "events_event_kind_check" CHECK (("event_kind" = ANY (ARRAY['event'::"text", 'reminder'::"text", 'session'::"text"]))),
    CONSTRAINT "events_event_status_check" CHECK (("event_status" = ANY (ARRAY['watching'::"text", 'planned'::"text", 'interested'::"text", 'going'::"text", 'cancelled'::"text", 'past'::"text", 'missed'::"text"]))),
    CONSTRAINT "events_event_type_check" CHECK (("event_type" = ANY (ARRAY['personal'::"text", 'friends'::"text", 'family'::"text", 'group'::"text"]))),
    CONSTRAINT "events_shared_with_friends_check" CHECK (("shared_with_friends" = ANY (ARRAY['none'::"text", 'all'::"text", 'selected'::"text"])))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."events"."image_url" IS 'Optional cover/hero image URL for timeline display';



COMMENT ON COLUMN "public"."events"."event_kind" IS 'event = full event (URL, RSVP, watch); reminder = simple appointment/reminder';



CREATE TABLE IF NOT EXISTS "public"."family_members" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "relation" "text" NOT NULL,
    "dob" "date",
    "gender" "text",
    "goals" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "interests" "text"[] DEFAULT '{}'::"text"[] NOT NULL
);


ALTER TABLE "public"."family_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."friend_group_members" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."friend_group_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."friend_groups" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."friend_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_state" (
    "state" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval) NOT NULL
);


ALTER TABLE "public"."oauth_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_facts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subject" "text" NOT NULL,
    "predicate" "text" NOT NULL,
    "value" "text" NOT NULL,
    "confidence" double precision DEFAULT 0.7 NOT NULL,
    "observed_count" integer DEFAULT 1 NOT NULL,
    "source" "text" NOT NULL,
    "is_historical" boolean DEFAULT false NOT NULL,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profile_facts_confidence_check" CHECK ((("confidence" >= (0)::double precision) AND ("confidence" <= (1)::double precision))),
    CONSTRAINT "profile_facts_source_check" CHECK (("source" = ANY (ARRAY['agent_inferred'::"text", 'user_stated'::"text"])))
);


ALTER TABLE "public"."profile_facts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."relationships" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "related_user_id" "uuid" NOT NULL,
    "relationship_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "relationships_check" CHECK (("user_id" <> "related_user_id")),
    CONSTRAINT "relationships_relationship_type_check" CHECK (("relationship_type" = ANY (ARRAY['friend'::"text", 'family'::"text", 'both'::"text"]))),
    CONSTRAINT "relationships_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stories" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "cover_url" "text",
    "user_notes" "text",
    "mood" "text",
    "tone" "text",
    "date_from" "date",
    "date_to" "date",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "edited_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "language" "text" DEFAULT 'en'::"text" NOT NULL,
    "story_group_id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL
);


ALTER TABLE "public"."stories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."story_events" (
    "story_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL
);


ALTER TABLE "public"."story_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_locations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "address" "text" DEFAULT ''::"text" NOT NULL,
    "city" "text" DEFAULT ''::"text" NOT NULL,
    "country" "text" DEFAULT ''::"text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_oauth_tokens" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "refresh_token" "text" NOT NULL,
    "access_token" "text",
    "expires_at" timestamp with time zone,
    "scopes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_oauth_tokens_provider_check" CHECK (("provider" = 'google'::"text"))
);


ALTER TABLE "public"."user_oauth_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "user_id" "uuid" NOT NULL,
    "dob" "date",
    "goals" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "interests" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "timezone" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "story_languages" "text"[] DEFAULT '{en}'::"text"[] NOT NULL,
    CONSTRAINT "story_languages_max_3" CHECK (("array_length"("story_languages", 1) <= 3)),
    CONSTRAINT "story_languages_nonempty" CHECK (("array_length"("story_languages", 1) >= 1))
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_settings" (
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "api_key" "text",
    "base_url" "text",
    "default_model" "text",
    "is_default" boolean DEFAULT false NOT NULL,
    "last_used_at" timestamp with time zone,
    "last_error_at" timestamp with time zone,
    "last_error_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_settings" IS 'Per-user BYOK AI provider settings. One row per (user, provider). At most one row per user has is_default=true.';



CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "preferred_language" "text" DEFAULT 'en'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."users" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_tasks"
    ADD CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_allowed_emails"
    ADD CONSTRAINT "app_allowed_emails_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_invites"
    ADD CONSTRAINT "event_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_invites"
    ADD CONSTRAINT "event_invites_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."event_memories"
    ADD CONSTRAINT "event_memories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_rsvps"
    ADD CONSTRAINT "event_rsvps_event_id_user_id_key" UNIQUE ("event_id", "user_id");



ALTER TABLE ONLY "public"."event_rsvps"
    ADD CONSTRAINT "event_rsvps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_shared_with_groups"
    ADD CONSTRAINT "event_shared_with_groups_pkey" PRIMARY KEY ("event_id", "group_id");



ALTER TABLE ONLY "public"."event_shared_with_users"
    ADD CONSTRAINT "event_shared_with_users_pkey" PRIMARY KEY ("event_id", "user_id");



ALTER TABLE ONLY "public"."event_source_refs"
    ADD CONSTRAINT "event_source_refs_event_id_source_id_key" UNIQUE ("event_id", "source_id");



ALTER TABLE ONLY "public"."event_source_refs"
    ADD CONSTRAINT "event_source_refs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_sources"
    ADD CONSTRAINT "event_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_sources"
    ADD CONSTRAINT "event_sources_user_id_domain_key" UNIQUE ("user_id", "domain");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."friend_group_members"
    ADD CONSTRAINT "friend_group_members_pkey" PRIMARY KEY ("group_id", "user_id");



ALTER TABLE ONLY "public"."friend_groups"
    ADD CONSTRAINT "friend_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_state"
    ADD CONSTRAINT "oauth_state_pkey" PRIMARY KEY ("state");



ALTER TABLE ONLY "public"."profile_facts"
    ADD CONSTRAINT "profile_facts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."relationships"
    ADD CONSTRAINT "relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."relationships"
    ADD CONSTRAINT "relationships_user_id_related_user_id_key" UNIQUE ("user_id", "related_user_id");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."story_events"
    ADD CONSTRAINT "story_events_pkey" PRIMARY KEY ("story_id", "event_id");



ALTER TABLE ONLY "public"."user_locations"
    ADD CONSTRAINT "user_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_oauth_tokens"
    ADD CONSTRAINT "user_oauth_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_oauth_tokens"
    ADD CONSTRAINT "user_oauth_tokens_user_id_provider_key" UNIQUE ("user_id", "provider");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id", "provider");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "agent_tasks_event_id_task_type_key" ON "public"."agent_tasks" USING "btree" ("event_id", "task_type");



CREATE UNIQUE INDEX "event_memories_event_external_uniq" ON "public"."event_memories" USING "btree" ("event_id", "external_id");



CREATE INDEX "event_memories_event_taken_at_idx" ON "public"."event_memories" USING "btree" ("event_id", "taken_at" DESC NULLS LAST);



CREATE INDEX "event_source_refs_source_id_idx" ON "public"."event_source_refs" USING "btree" ("source_id");



CREATE INDEX "event_sources_user_id_idx" ON "public"."event_sources" USING "btree" ("user_id");



CREATE INDEX "events_parent_event_id_idx" ON "public"."events" USING "btree" ("parent_event_id");



CREATE INDEX "idx_audit_log_actor_role" ON "public"."audit_log" USING "btree" ("actor_role") WHERE ("actor_role" IS NOT NULL);



CREATE INDEX "idx_audit_log_occurred_at" ON "public"."audit_log" USING "btree" ("occurred_at" DESC);



CREATE INDEX "idx_audit_log_table" ON "public"."audit_log" USING "btree" ("schema_name", "table_name");



CREATE INDEX "idx_event_invites_event_id" ON "public"."event_invites" USING "btree" ("event_id");



CREATE INDEX "idx_event_invites_token" ON "public"."event_invites" USING "btree" ("token");



CREATE INDEX "idx_event_memories_event_id" ON "public"."event_memories" USING "btree" ("event_id");



CREATE INDEX "idx_event_rsvps_event_id" ON "public"."event_rsvps" USING "btree" ("event_id");



CREATE INDEX "idx_event_rsvps_user_id" ON "public"."event_rsvps" USING "btree" ("user_id");



CREATE INDEX "idx_event_shared_with_groups_group_id" ON "public"."event_shared_with_groups" USING "btree" ("group_id");



CREATE INDEX "idx_event_shared_with_users_user_id" ON "public"."event_shared_with_users" USING "btree" ("user_id");



CREATE INDEX "idx_events_created_by" ON "public"."events" USING "btree" ("created_by");



CREATE INDEX "idx_events_hashtags" ON "public"."events" USING "gin" ("hashtags");



CREATE INDEX "idx_events_start_date" ON "public"."events" USING "btree" ("start_date");



CREATE INDEX "idx_family_members_user_id" ON "public"."family_members" USING "btree" ("user_id");



CREATE INDEX "idx_friend_group_members_user_id" ON "public"."friend_group_members" USING "btree" ("user_id");



CREATE INDEX "idx_friend_groups_created_by" ON "public"."friend_groups" USING "btree" ("created_by");



CREATE INDEX "idx_oauth_state_expires_at" ON "public"."oauth_state" USING "btree" ("expires_at");



CREATE INDEX "idx_profile_facts_lookup" ON "public"."profile_facts" USING "btree" ("user_id", "subject", "predicate", "is_historical");



CREATE INDEX "idx_profile_facts_subject" ON "public"."profile_facts" USING "btree" ("user_id", "subject");



CREATE INDEX "idx_profile_facts_user_id" ON "public"."profile_facts" USING "btree" ("user_id");



CREATE INDEX "idx_relationships_related_user_id" ON "public"."relationships" USING "btree" ("related_user_id");



CREATE INDEX "idx_relationships_user_id" ON "public"."relationships" USING "btree" ("user_id");



CREATE INDEX "idx_user_locations_user_id" ON "public"."user_locations" USING "btree" ("user_id");



CREATE INDEX "idx_user_oauth_tokens_user_id" ON "public"."user_oauth_tokens" USING "btree" ("user_id");



CREATE INDEX "stories_group_idx" ON "public"."stories" USING "btree" ("story_group_id");



CREATE INDEX "stories_user_generated_idx" ON "public"."stories" USING "btree" ("user_id", "generated_at" DESC);



CREATE INDEX "stories_user_lang_generated_idx" ON "public"."stories" USING "btree" ("user_id", "language", "generated_at" DESC);



CREATE INDEX "story_events_event_idx" ON "public"."story_events" USING "btree" ("event_id");



CREATE UNIQUE INDEX "user_locations_one_default" ON "public"."user_locations" USING "btree" ("user_id") WHERE ("is_default" = true);



CREATE UNIQUE INDEX "user_settings_one_default" ON "public"."user_settings" USING "btree" ("user_id") WHERE "is_default";



CREATE OR REPLACE TRIGGER "audit_event_memories" AFTER INSERT OR DELETE OR UPDATE ON "public"."event_memories" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();



CREATE OR REPLACE TRIGGER "audit_events" AFTER INSERT OR DELETE OR UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();



CREATE OR REPLACE TRIGGER "audit_users" AFTER INSERT OR DELETE OR UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."audit_trigger_func"();



CREATE OR REPLACE TRIGGER "stories_set_edited_at" BEFORE UPDATE ON "public"."stories" FOR EACH ROW EXECUTE FUNCTION "public"."set_stories_edited_at"();



CREATE OR REPLACE TRIGGER "user_settings_updated_at" BEFORE UPDATE ON "public"."user_settings" FOR EACH ROW EXECUTE FUNCTION "public"."user_settings_set_updated_at"();



ALTER TABLE ONLY "public"."agent_tasks"
    ADD CONSTRAINT "agent_tasks_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_allowed_emails"
    ADD CONSTRAINT "app_allowed_emails_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_invites"
    ADD CONSTRAINT "event_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_invites"
    ADD CONSTRAINT "event_invites_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_memories"
    ADD CONSTRAINT "event_memories_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_memories"
    ADD CONSTRAINT "event_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_rsvps"
    ADD CONSTRAINT "event_rsvps_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_rsvps"
    ADD CONSTRAINT "event_rsvps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_shared_with_groups"
    ADD CONSTRAINT "event_shared_with_groups_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_shared_with_groups"
    ADD CONSTRAINT "event_shared_with_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."friend_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_shared_with_users"
    ADD CONSTRAINT "event_shared_with_users_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_shared_with_users"
    ADD CONSTRAINT "event_shared_with_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_source_refs"
    ADD CONSTRAINT "event_source_refs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_source_refs"
    ADD CONSTRAINT "event_source_refs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."event_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_source_refs"
    ADD CONSTRAINT "event_source_refs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_sources"
    ADD CONSTRAINT "event_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_parent_event_id_fkey" FOREIGN KEY ("parent_event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friend_group_members"
    ADD CONSTRAINT "friend_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."friend_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friend_group_members"
    ADD CONSTRAINT "friend_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friend_groups"
    ADD CONSTRAINT "friend_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_state"
    ADD CONSTRAINT "oauth_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile_facts"
    ADD CONSTRAINT "profile_facts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."relationships"
    ADD CONSTRAINT "relationships_related_user_id_fkey" FOREIGN KEY ("related_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."relationships"
    ADD CONSTRAINT "relationships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."story_events"
    ADD CONSTRAINT "story_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."story_events"
    ADD CONSTRAINT "story_events_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_locations"
    ADD CONSTRAINT "user_locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_oauth_tokens"
    ADD CONSTRAINT "user_oauth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_settings"
    ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



CREATE POLICY "Allow audit insert from triggers" ON "public"."audit_log" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow insert for authenticated" ON "public"."oauth_state" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Anyone can read invite by token" ON "public"."event_invites" FOR SELECT USING (true);



CREATE POLICY "Authenticated users can invite" ON "public"."app_allowed_emails" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Creator can manage own event invites" ON "public"."event_invites" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_invites"."event_id") AND ("e"."created_by" = "auth"."uid"())))));



CREATE POLICY "Creators can manage event_shared_with_users for own events" ON "public"."event_shared_with_users" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_shared_with_users"."event_id") AND ("e"."created_by" = "auth"."uid"())))));



CREATE POLICY "Event creators can manage group sharing" ON "public"."event_shared_with_groups" USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_shared_with_groups"."event_id") AND ("e"."created_by" = "auth"."uid"())))));



CREATE POLICY "Group members can view event_shared_with_groups" ON "public"."event_shared_with_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."friend_group_members" "fgm"
  WHERE (("fgm"."group_id" = "event_shared_with_groups"."group_id") AND ("fgm"."user_id" = "auth"."uid"())))));



CREATE POLICY "Group owners can manage members" ON "public"."friend_group_members" USING ((EXISTS ( SELECT 1
   FROM "public"."friend_groups" "fg"
  WHERE (("fg"."id" = "friend_group_members"."group_id") AND ("fg"."created_by" = "auth"."uid"())))));



CREATE POLICY "Group owners can view event_shared_with_groups" ON "public"."event_shared_with_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."friend_groups" "fg"
  WHERE (("fg"."id" = "event_shared_with_groups"."group_id") AND ("fg"."created_by" = "auth"."uid"())))));



CREATE POLICY "Members can view their groups" ON "public"."friend_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."friend_group_members" "fgm"
  WHERE (("fgm"."group_id" = "friend_groups"."id") AND ("fgm"."user_id" = "auth"."uid"())))));



CREATE POLICY "Members can view their own memberships" ON "public"."friend_group_members" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "No read for app users" ON "public"."app_allowed_emails" FOR SELECT USING (false);



CREATE POLICY "No read for app users" ON "public"."audit_log" FOR SELECT USING (false);



CREATE POLICY "Owners can manage their groups" ON "public"."friend_groups" USING (("created_by" = "auth"."uid"()));



CREATE POLICY "Service role for agent_tasks" ON "public"."agent_tasks" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Users can delete own RSVP" ON "public"."event_rsvps" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own events" ON "public"."events" FOR DELETE USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Users can delete own memory" ON "public"."event_memories" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own stories" ON "public"."stories" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own story_events" ON "public"."story_events" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_events"."story_id") AND ("s"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own RSVP" ON "public"."event_rsvps" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own events" ON "public"."events" FOR INSERT WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "Users can insert own memory" ON "public"."event_memories" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own stories" ON "public"."stories" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own story_events" ON "public"."story_events" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_events"."story_id") AND ("s"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can manage own agent tasks" ON "public"."agent_tasks" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "agent_tasks"."event_id") AND ("events"."created_by" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."events"
  WHERE (("events"."id" = "agent_tasks"."event_id") AND ("events"."created_by" = "auth"."uid"())))));



CREATE POLICY "Users can manage own oauth tokens" ON "public"."user_oauth_tokens" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own relationships" ON "public"."relationships" USING ((("auth"."uid"() = "user_id") OR ("auth"."uid"() = "related_user_id")));



CREATE POLICY "Users can update own RSVP" ON "public"."event_rsvps" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own events" ON "public"."events" FOR UPDATE USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Users can update own profile" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own stories" ON "public"."stories" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own story_events" ON "public"."story_events" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_events"."story_id") AND ("s"."user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_events"."story_id") AND ("s"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view RSVPs for events they can see" ON "public"."event_rsvps" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_rsvps"."event_id") AND (("e"."created_by" = "auth"."uid"()) OR "public"."user_in_event_shared_with_users"("e"."id") OR ("e"."shared_with_family" AND (EXISTS ( SELECT 1
           FROM "public"."relationships" "r"
          WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['family'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "e"."created_by")) OR (("r"."user_id" = "e"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))) OR (("e"."shared_with_friends" = 'all'::"text") AND (EXISTS ( SELECT 1
           FROM "public"."relationships" "r"
          WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['friend'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "e"."created_by")) OR (("r"."user_id" = "e"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))))))));



CREATE POLICY "Users can view event memories" ON "public"."event_memories" FOR SELECT USING (true);



CREATE POLICY "Users can view event_shared_with_users for events they can see" ON "public"."event_shared_with_users" FOR SELECT USING (true);



CREATE POLICY "Users can view events shared with all friends" ON "public"."events" FOR SELECT USING ((("shared_with_friends" = 'all'::"text") AND ("created_by" <> "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."relationships" "r"
  WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['friend'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "events"."created_by")) OR (("r"."user_id" = "events"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))));



CREATE POLICY "Users can view memories for events they can see" ON "public"."event_memories" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."events" "e"
  WHERE (("e"."id" = "event_memories"."event_id") AND (("e"."created_by" = "auth"."uid"()) OR "public"."user_in_event_shared_with_users"("e"."id") OR ("e"."shared_with_family" AND (EXISTS ( SELECT 1
           FROM "public"."relationships" "r"
          WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['family'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "e"."created_by")) OR (("r"."user_id" = "e"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))) OR (("e"."shared_with_friends" = 'all'::"text") AND (EXISTS ( SELECT 1
           FROM "public"."relationships" "r"
          WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['friend'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "e"."created_by")) OR (("r"."user_id" = "e"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))))))));



CREATE POLICY "Users can view own events" ON "public"."events" FOR SELECT USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Users can view own profile" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own stories" ON "public"."stories" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own story_events" ON "public"."story_events" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_events"."story_id") AND ("s"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view profiles of friends and family" ON "public"."users" FOR SELECT USING ((("auth"."uid"() = "id") OR (EXISTS ( SELECT 1
   FROM "public"."relationships" "r"
  WHERE (("r"."status" = 'accepted'::"text") AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "users"."id")) OR (("r"."user_id" = "users"."id") AND ("r"."related_user_id" = "auth"."uid"()))))))));



CREATE POLICY "Users see own source refs" ON "public"."event_source_refs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users see own sources" ON "public"."event_sources" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."agent_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_allowed_emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_memories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_rsvps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_shared_with_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_shared_with_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_source_refs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."family_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_members: owner only" ON "public"."family_members" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."friend_group_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."friend_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_facts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_facts: owner only" ON "public"."profile_facts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."relationships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."story_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_locations: owner only" ON "public"."user_locations" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_oauth_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles: owner only" ON "public"."user_profiles" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_settings: owner only" ON "public"."user_settings" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."accept_relationship"("rel_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."accept_relationship"("rel_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_relationship"("rel_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."audit_trigger_func"() TO "anon";
GRANT ALL ON FUNCTION "public"."audit_trigger_func"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."audit_trigger_func"() TO "service_role";



GRANT ALL ON FUNCTION "public"."decline_relationship"("rel_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."decline_relationship"("rel_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decline_relationship"("rel_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_invite_by_token"("invite_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_invite_by_token"("invite_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_invite_by_token"("invite_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_relationship_requests"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_relationship_requests"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_relationship_requests"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."join_event_by_invite"("invite_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."join_event_by_invite"("invite_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_event_by_invite"("invite_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."send_relationship_request"("target_email" "text", "rel_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."send_relationship_request"("target_email" "text", "rel_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_relationship_request"("target_email" "text", "rel_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_stories_edited_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_stories_edited_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_stories_edited_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."user_in_event_shared_with_groups"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_in_event_shared_with_groups"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_in_event_shared_with_groups"("p_event_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."user_in_event_shared_with_users"("p_event_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_in_event_shared_with_users"("p_event_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_in_event_shared_with_users"("p_event_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."user_settings_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."user_settings_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_settings_set_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."agent_tasks" TO "anon";
GRANT ALL ON TABLE "public"."agent_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."app_allowed_emails" TO "anon";
GRANT ALL ON TABLE "public"."app_allowed_emails" TO "authenticated";
GRANT ALL ON TABLE "public"."app_allowed_emails" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."event_invites" TO "anon";
GRANT ALL ON TABLE "public"."event_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."event_invites" TO "service_role";



GRANT ALL ON TABLE "public"."event_memories" TO "anon";
GRANT ALL ON TABLE "public"."event_memories" TO "authenticated";
GRANT ALL ON TABLE "public"."event_memories" TO "service_role";



GRANT ALL ON TABLE "public"."event_rsvps" TO "anon";
GRANT ALL ON TABLE "public"."event_rsvps" TO "authenticated";
GRANT ALL ON TABLE "public"."event_rsvps" TO "service_role";



GRANT ALL ON TABLE "public"."event_shared_with_groups" TO "anon";
GRANT ALL ON TABLE "public"."event_shared_with_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."event_shared_with_groups" TO "service_role";



GRANT ALL ON TABLE "public"."event_shared_with_users" TO "anon";
GRANT ALL ON TABLE "public"."event_shared_with_users" TO "authenticated";
GRANT ALL ON TABLE "public"."event_shared_with_users" TO "service_role";



GRANT ALL ON TABLE "public"."event_source_refs" TO "anon";
GRANT ALL ON TABLE "public"."event_source_refs" TO "authenticated";
GRANT ALL ON TABLE "public"."event_source_refs" TO "service_role";



GRANT ALL ON TABLE "public"."event_sources" TO "anon";
GRANT ALL ON TABLE "public"."event_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."event_sources" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."family_members" TO "anon";
GRANT ALL ON TABLE "public"."family_members" TO "authenticated";
GRANT ALL ON TABLE "public"."family_members" TO "service_role";



GRANT ALL ON TABLE "public"."friend_group_members" TO "anon";
GRANT ALL ON TABLE "public"."friend_group_members" TO "authenticated";
GRANT ALL ON TABLE "public"."friend_group_members" TO "service_role";



GRANT ALL ON TABLE "public"."friend_groups" TO "anon";
GRANT ALL ON TABLE "public"."friend_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."friend_groups" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_state" TO "anon";
GRANT ALL ON TABLE "public"."oauth_state" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_state" TO "service_role";



GRANT ALL ON TABLE "public"."profile_facts" TO "anon";
GRANT ALL ON TABLE "public"."profile_facts" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_facts" TO "service_role";



GRANT ALL ON TABLE "public"."relationships" TO "anon";
GRANT ALL ON TABLE "public"."relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."relationships" TO "service_role";



GRANT ALL ON TABLE "public"."stories" TO "anon";
GRANT ALL ON TABLE "public"."stories" TO "authenticated";
GRANT ALL ON TABLE "public"."stories" TO "service_role";



GRANT ALL ON TABLE "public"."story_events" TO "anon";
GRANT ALL ON TABLE "public"."story_events" TO "authenticated";
GRANT ALL ON TABLE "public"."story_events" TO "service_role";



GRANT ALL ON TABLE "public"."user_locations" TO "anon";
GRANT ALL ON TABLE "public"."user_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."user_locations" TO "service_role";



GRANT ALL ON TABLE "public"."user_oauth_tokens" TO "anon";
GRANT ALL ON TABLE "public"."user_oauth_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."user_oauth_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."user_settings" TO "anon";
GRANT ALL ON TABLE "public"."user_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."user_settings" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";








-- ============================================================================
-- auth.users trigger — wires public.handle_new_user on user signup
-- ============================================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ============================================================================
-- storage: event-photos bucket + policies
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('event-photos', 'event-photos', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'event-photos authenticated all'
  ) THEN
    CREATE POLICY "event-photos authenticated all"
      ON storage.objects FOR ALL
      TO authenticated
      USING (bucket_id = 'event-photos')
      WITH CHECK (bucket_id = 'event-photos');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'event-photos public read'
  ) THEN
    CREATE POLICY "event-photos public read"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'event-photos');
  END IF;
END $$;
