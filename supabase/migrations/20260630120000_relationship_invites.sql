-- Invite-to-friend for non-members.
--
-- Lets a user invite an email that has no Plannen account yet. The invite is
-- recorded in plannen.relationship_invites; when that email signs up, the
-- existing handle_new_user() trigger materializes the invite into an ACCEPTED
-- relationship (auto-accept, because they joined via the inviter's invite).
--
-- Tier 1/2 only. Tier 0 is single-user and never exercises this path
-- (the web service keeps its isTierZero() guard).

-- ── table ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plannen.relationship_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  invitee_email   text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  redeemed_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

-- One live invite per (inviter, email); a fresh invite is allowed once a prior
-- one is redeemed.
CREATE UNIQUE INDEX IF NOT EXISTS relationship_invites_pending_uniq
  ON plannen.relationship_invites (inviter_user_id, invitee_email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS relationship_invites_invitee_email_idx
  ON plannen.relationship_invites (invitee_email)
  WHERE status = 'pending';

ALTER TABLE plannen.relationship_invites OWNER TO postgres;
ALTER TABLE plannen.relationship_invites ENABLE ROW LEVEL SECURITY;

-- Inviter manages their own invite rows. Redemption happens inside a
-- SECURITY DEFINER trigger, so the joining user needs no read access here.
DROP POLICY IF EXISTS relationship_invites_select_own ON plannen.relationship_invites;
CREATE POLICY relationship_invites_select_own ON plannen.relationship_invites
  FOR SELECT USING (inviter_user_id = auth.uid());

DROP POLICY IF EXISTS relationship_invites_insert_own ON plannen.relationship_invites;
CREATE POLICY relationship_invites_insert_own ON plannen.relationship_invites
  FOR INSERT WITH CHECK (inviter_user_id = auth.uid());

DROP POLICY IF EXISTS relationship_invites_delete_own ON plannen.relationship_invites;
CREATE POLICY relationship_invites_delete_own ON plannen.relationship_invites
  FOR DELETE USING (inviter_user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON plannen.relationship_invites TO authenticated;
GRANT ALL ON plannen.relationship_invites TO service_role;

-- ── smart entry point ───────────────────────────────────────────────────────
-- Existing user  -> pending friend request (same as send_relationship_request)
--                   returns {"kind":"request","rel_id":...}
-- Unknown email  -> pending invite (refreshes expiry on re-invite)
--                   returns {"kind":"invite","invite_id":...}
CREATE OR REPLACE FUNCTION plannen.invite_or_request_relationship(target_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = plannen, public
AS $$
DECLARE
  v_me        uuid := auth.uid();
  v_email     text := lower(trim(target_email));
  v_other_id  uuid;
  v_rel_id    uuid;
  v_invite_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;

  SELECT id INTO v_other_id FROM plannen.users WHERE lower(trim(email)) = v_email LIMIT 1;

  IF v_other_id IS NOT NULL THEN
    IF v_other_id = v_me THEN
      RAISE EXCEPTION 'You cannot add yourself.';
    END IF;
    INSERT INTO plannen.relationships (user_id, related_user_id, status)
    VALUES (v_me, v_other_id, 'pending')
    ON CONFLICT (user_id, related_user_id) DO UPDATE SET
      status = 'pending',
      updated_at = now()
    RETURNING id INTO v_rel_id;
    RETURN jsonb_build_object('kind', 'request', 'rel_id', v_rel_id);
  END IF;

  INSERT INTO plannen.relationship_invites (inviter_user_id, invitee_email, status, expires_at)
  VALUES (v_me, v_email, 'pending', now() + interval '30 days')
  ON CONFLICT (inviter_user_id, invitee_email) WHERE status = 'pending'
  DO UPDATE SET expires_at = now() + interval '30 days'
  RETURNING id INTO v_invite_id;
  RETURN jsonb_build_object('kind', 'invite', 'invite_id', v_invite_id);
END;
$$;

ALTER FUNCTION plannen.invite_or_request_relationship(text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION plannen.invite_or_request_relationship(text) TO authenticated;
GRANT EXECUTE ON FUNCTION plannen.invite_or_request_relationship(text) TO service_role;

-- ── redemption on signup ────────────────────────────────────────────────────
-- Extends the existing auth.users -> plannen.users trigger function. After the
-- user row is upserted, every pending non-expired invite addressed to the new
-- email becomes an ACCEPTED relationship, and the invite is marked redeemed.
CREATE OR REPLACE FUNCTION plannen.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_email text := lower(trim(NEW.email));
BEGIN
  INSERT INTO plannen.users (id, email, full_name, avatar_url)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'avatar_url')
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, users.full_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
    updated_at = now();

  IF v_email IS NOT NULL AND v_email <> '' THEN
    -- Materialize friend invites addressed to this email.
    INSERT INTO plannen.relationships (user_id, related_user_id, status)
    SELECT ri.inviter_user_id, NEW.id, 'accepted'
    FROM plannen.relationship_invites ri
    WHERE ri.status = 'pending'
      AND ri.expires_at > now()
      AND lower(trim(ri.invitee_email)) = v_email
      AND ri.inviter_user_id <> NEW.id
    ON CONFLICT (user_id, related_user_id) DO UPDATE SET
      status = 'accepted',
      updated_at = now();

    UPDATE plannen.relationship_invites
    SET status = 'redeemed', redeemed_at = now()
    WHERE status = 'pending'
      AND expires_at > now()
      AND lower(trim(invitee_email)) = v_email;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION plannen.handle_new_user() OWNER TO postgres;
