-- Decouple "when I prefer to visit" from "whether I'm attending" (issue #5).
--
-- preferred_visit_date used to live on plannen.event_rsvps, which coupled a
-- planning hint to RSVP status and forced every visit-date write to imply an
-- RSVP. This moves the hint into its own table so a visit date can be set
-- without an RSVP, and an RSVP can change without disturbing the visit date.
--
-- Forward-only and additive: the old event_rsvps.preferred_visit_date column
-- is left in place (no longer read or written) so this migration cannot lose
-- data. Existing values are copied across below.

CREATE TABLE IF NOT EXISTS "plannen"."event_visit_preferences" (
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "visit_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "event_visit_preferences_pkey" PRIMARY KEY ("event_id", "user_id")
);

ALTER TABLE "plannen"."event_visit_preferences" OWNER TO "postgres";

ALTER TABLE ONLY "plannen"."event_visit_preferences"
    ADD CONSTRAINT "event_visit_preferences_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "plannen"."events"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "plannen"."event_visit_preferences"
    ADD CONSTRAINT "event_visit_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "plannen"."users"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_event_visit_preferences_event_id" ON "plannen"."event_visit_preferences" USING "btree" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_event_visit_preferences_user_id" ON "plannen"."event_visit_preferences" USING "btree" ("user_id");

ALTER TABLE "plannen"."event_visit_preferences" ENABLE ROW LEVEL SECURITY;

-- SELECT: readable for any event the caller can see. Mirrors the event_rsvps
-- SELECT policy verbatim (creator + shared-with-users + shared-with-family +
-- shared-with-friends), so getCreatorPreferredVisitDates can still read a
-- shared event creator's visit date.
CREATE POLICY "Users can view visit prefs for events they can see" ON "plannen"."event_visit_preferences" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "plannen"."events" "e"
  WHERE (("e"."id" = "event_visit_preferences"."event_id") AND (("e"."created_by" = "auth"."uid"()) OR "plannen"."user_in_event_shared_with_users"("e"."id") OR ("e"."shared_with_family" AND (EXISTS ( SELECT 1
           FROM "plannen"."relationships" "r"
          WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['family'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "e"."created_by")) OR (("r"."user_id" = "e"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))) OR (("e"."shared_with_friends" = 'all'::"text") AND (EXISTS ( SELECT 1
           FROM "plannen"."relationships" "r"
          WHERE (("r"."status" = 'accepted'::"text") AND ("r"."relationship_type" = ANY (ARRAY['friend'::"text", 'both'::"text"])) AND ((("r"."user_id" = "auth"."uid"()) AND ("r"."related_user_id" = "e"."created_by")) OR (("r"."user_id" = "e"."created_by") AND ("r"."related_user_id" = "auth"."uid"()))))))))))));

-- Write policies: a user may only mutate their own row.
CREATE POLICY "Users can insert own visit pref" ON "plannen"."event_visit_preferences" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can update own visit pref" ON "plannen"."event_visit_preferences" FOR UPDATE USING (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can delete own visit pref" ON "plannen"."event_visit_preferences" FOR DELETE USING (("auth"."uid"() = "user_id"));

GRANT ALL ON TABLE "plannen"."event_visit_preferences" TO "anon";
GRANT ALL ON TABLE "plannen"."event_visit_preferences" TO "authenticated";
GRANT ALL ON TABLE "plannen"."event_visit_preferences" TO "service_role";

-- Carry existing values across. ON CONFLICT DO NOTHING keeps this idempotent.
INSERT INTO "plannen"."event_visit_preferences" ("event_id", "user_id", "visit_date", "updated_at")
SELECT "event_id", "user_id", "preferred_visit_date", "updated_at"
FROM "plannen"."event_rsvps"
WHERE "preferred_visit_date" IS NOT NULL
ON CONFLICT ("event_id", "user_id") DO NOTHING;
