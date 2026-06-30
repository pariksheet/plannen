# Invite-to-friend for non-members — design

**Date:** 2026-06-30
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** Tier 1/2 (multi-user) only. Tier 0 is single-user and already no-ops all relationship/invite flows.

## Problem

Today "Add a person" (`AddPerson.tsx` → `sendRelationshipRequest` → `send_relationship_request` RPC)
only works when the target email **already** belongs to a Plannen account. The RPC raises
`"No account found with that email. They need to sign up first."` for unknown emails
(`supabase/migrations/20260520150000_drop_relationship_type.sql`).

Two unrelated invite mechanisms exist but neither creates a friendship:

- `InviteToApp.tsx` + `send-invite-email` edge function — emails a non-user a link to *join Plannen*,
  but records nothing about who invited whom.
- `inviteService.ts` + `EventInviteModal` — token link to join *one specific event*, not a friendship.

The missing piece is the **bridge**: record "I invited email X as a friend" → when X signs up →
create the friendship automatically.

## Decisions (from brainstorm)

1. **Auto-accept on join.** Because the person joined through the inviter's personal invite, the
   friendship is created with status `accepted` immediately — no extra confirmation tap.
2. **One smart box.** Keep a single "Add a person" email field. Existing user → friend request as
   today; unknown email → join invite + queued auto-friendship. The user does not need to know
   whether the target is already a member.
3. **Email-matched pending invites + signup trigger** (chosen over a token-link approach). Redemption
   is automatic regardless of how the invitee signs up (invite link, bookmark, typed URL), because
   email is already the login identity (OTP).
4. **Show sent invites with cancel.** The inviter can see pending invites they've sent and cancel them.
5. **30-day invite expiry.**

## Data model

New table, Tier 1/2 only, created in a forward-only timestamped migration under
`supabase/migrations/`:

```sql
CREATE TABLE plannen.relationship_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  invitee_email   text NOT NULL,                 -- stored lower(trim(email))
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','redeemed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  redeemed_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

-- one live invite per (inviter, email); allows a fresh invite after a prior one is redeemed
CREATE UNIQUE INDEX relationship_invites_pending_uniq
  ON plannen.relationship_invites (inviter_user_id, invitee_email)
  WHERE status = 'pending';

CREATE INDEX relationship_invites_invitee_email_idx
  ON plannen.relationship_invites (invitee_email) WHERE status = 'pending';
```

**RLS:**
- `inviter_user_id = auth.uid()` for SELECT / INSERT / DELETE (inviter manages their own rows).
- No invitee-facing read path is needed: redemption runs inside a `SECURITY DEFINER` trigger, so the
  joining user never queries this table directly.

## Smart box: `invite_or_request_relationship(target_email text)`

`SECURITY DEFINER`, `SET search_path = plannen, public`. Returns JSON:

- Resolve `v_other_id` from `plannen.users` by `lower(trim(email))`.
- **Existing user** → perform the current `send_relationship_request` behaviour (insert/upsert a
  `pending` `relationships` row) and return `{ "kind": "request", "rel_id": <uuid> }`.
  - Keep the existing self-add guard (`cannot add yourself`).
- **Unknown email** → upsert a `pending` `relationship_invites` row (refreshing `expires_at` on
  conflict) and return `{ "kind": "invite", "invite_id": <uuid> }`.

`send_relationship_request` stays in place (back-compat); the new RPC is what the web app calls.

### Web service / UI

- `relationshipService.ts`: add `inviteOrRequest(email)` calling the new RPC; keep the
  `isTierZero()` guard returning the existing single-user message.
- `AddPerson.tsx`: single email field unchanged. After success, branch the copy on `kind`:
  - `request` → `"Request sent. They'll see it in their pending requests and can accept."`
  - `invite`  → fire the existing `send-invite-email` function, then show
    `"Invite sent — they'll be added to your people automatically when they join."`
- **Sent-invites list with cancel:** surface pending `relationship_invites` (inviter's own rows),
  shown near Pending Requests. Cancel deletes the pending row (RLS-scoped DELETE). New service
  helpers: `listSentInvites()`, `cancelInvite(inviteId)`.

### Invite email

Reuse `send-invite-email` as-is. Optional warmth: pass the inviter's display name so the body reads
"You're invited to join Plannen by <name>". If added, update
`supabase/functions/_shared/handlers/send-invite-email.test.ts` accordingly. No personal data in the
repo — tests use generic personas.

## Redemption on signup

Extend the existing `plannen.handle_new_user()` trigger function (already
`AFTER INSERT ON auth.users`, already inserts into `plannen.users` with `NEW.email`). After the
current `INSERT INTO plannen.users … ON CONFLICT …`, add: for every `pending`, non-expired invite
where `invitee_email = lower(NEW.email)`:

- insert an **accepted** `relationships` row pairing `inviter_user_id` ↔ `NEW.id`, reusing the
  existing `ON CONFLICT (user_id, related_user_id) DO UPDATE` so it is idempotent;
- set the invite `status = 'redeemed'`, `redeemed_at = now()`.

Runs once per signup, inside the same `SECURITY DEFINER` function, so it fires no matter how the user
signs up. Expired or already-redeemed invites are skipped.

## Edge cases

- **Already a member at invite time** → smart box takes the `request` branch; no invite row created.
- **Same email invited by two people** → two pending rows → both become accepted friendships on join.
- **Re-inviting same email** → upsert on the partial unique index; no duplicate; `expires_at` refreshed.
- **Never joins** → invite expires after 30 days; harmless; can be GC'd later (out of scope).
- **Joins after expiry** → redemption skips expired rows; inviter can re-invite.
- **Tier 0** → table/RPC unused; service keeps `isTierZero()` guard and the single-user message.

## Testing & parity

- SQL tests for `invite_or_request_relationship`: existing-user branch (creates pending relationship)
  and unknown-email branch (creates pending invite; re-invite upserts, no dup).
- Redemption test: simulate an `auth.users` insert for an invited email → assert an `accepted`
  relationship exists and the invite is `redeemed`; assert expired invites are not redeemed.
- `send-invite-email` edge-function test updated only if the inviter-name param is added.
- **No MCP tool changes** — relationships are web-UI-only, so the `mcp/src/index.ts` ↔
  `supabase/functions/mcp/` parity surface is untouched; `scripts/check-mcp-parity.mjs` is unaffected.
- **No recurrence/scheduling engine changes** — `scripts/check-engine-parity.mjs` unaffected.
- Migration is forward-only (one new timestamped file), applied via `npx plannen migrate` on each
  active profile; deploy the updated edge function(s) afterward.

## Out of scope

- Token-based personalized "X invited you" join screen (Approach B/C). Email-match + inviter name in
  the email body covers the warmth without the token machinery.
- Background GC of expired invite rows.
- Per-connection event-view splitting (separate, pre-existing stub noted in `MyPeople.tsx`).
