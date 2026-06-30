# Invite-to-friend for non-members — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user invite someone who has no Plannen account; when that person signs up, they auto-become an accepted friend.

**Architecture:** A `relationship_invites` table records pending email invites. One smart RPC (`invite_or_request_relationship`) either sends a normal friend request (existing user) or records a pending invite (unknown email). The existing `handle_new_user()` signup trigger materializes pending invites for the new email into `accepted` relationships. Web UI uses a single "Add a person" box plus a "sent invites" list with cancel.

**Tech Stack:** Postgres (plpgsql, SECURITY DEFINER RPCs/trigger), Supabase RLS, React/TS web app, vitest.

## Global Constraints

- Tier 1/2 only. Tier 0 keeps the existing `isTierZero()` single-user guard.
- Repo is PUBLIC — no personal data in code/tests/docs; generic personas only.
- DB migrations forward-only: one new timestamped file under `supabase/migrations/`. Never edit existing migrations. Apply with `npx plannen migrate`.
- `relationships` unique key is `(user_id, related_user_id)`; status ∈ {pending, accepted, blocked}; `relationship_type` no longer exists.
- No MCP tool changes (relationships are web-UI-only) → parity scripts untouched.
- Prefer `npx plannen <verb>` over raw supabase/vercel.

---

### Task 1: Migration — table, RPC, trigger extension

**Files:**
- Create: `supabase/migrations/20260630120000_relationship_invites.sql`

**Produces:** table `plannen.relationship_invites`; RPC `plannen.invite_or_request_relationship(text) returns jsonb`; updated `plannen.handle_new_user()`.

- [ ] **Step 1:** Write the migration:
  - `CREATE TABLE plannen.relationship_invites` (id, inviter_user_id FK users ON DELETE CASCADE, invitee_email text, status default 'pending' CHECK in (pending,redeemed), created_at, redeemed_at, expires_at default now()+30d).
  - Partial unique index `(inviter_user_id, invitee_email) WHERE status='pending'`; index on `(invitee_email) WHERE status='pending'`.
  - Enable RLS; policies: SELECT/INSERT/DELETE where `inviter_user_id = auth.uid()`. Grants to authenticated/service_role.
  - `CREATE OR REPLACE FUNCTION plannen.invite_or_request_relationship(target_email text) RETURNS jsonb SECURITY DEFINER` — existing user → upsert pending relationship (same as `send_relationship_request`) → `{'kind':'request','rel_id':...}`; else upsert pending invite (refresh expires_at) → `{'kind':'invite','invite_id':...}`. Guard not-authenticated and self-add.
  - `CREATE OR REPLACE FUNCTION plannen.handle_new_user()` — keep existing users upsert, then loop pending non-expired invites where `invitee_email = lower(NEW.email)`: insert accepted relationship (`ON CONFLICT (user_id, related_user_id) DO UPDATE SET status='accepted'`), set invite redeemed.
  - GRANT EXECUTE on the new RPC to authenticated.
- [ ] **Step 2:** Apply to **local_sb** first: `PLANNEN_PROFILE=local_sb npx plannen up` (if needed) then `PLANNEN_PROFILE=local_sb npx plannen migrate`. Expected: applies clean. If local_sb Docker is down, validate SQL with `supabase db lint`/manual psql; do NOT touch prod yet.
- [ ] **Step 3:** Commit.

### Task 2: Web service — `relationshipService.ts`

**Files:** Modify `src/services/relationshipService.ts`; Test `src/services/relationshipService.test.ts` (new).

**Produces:** `inviteOrRequest(email): Promise<{ data: { kind:'request'|'invite' } | null; error }>`, `listSentInvites(): Promise<{ data: SentInvite[]; error }>`, `cancelInvite(id): Promise<{ error }>`. Type `SentInvite { id, invitee_email, created_at, expires_at }`.

- [ ] **Step 1:** Write failing tests (mock `supabase.rpc`/`.from`): inviteOrRequest returns kind from RPC; tier0 returns single-user error; cancelInvite deletes; listSentInvites maps rows.
- [ ] **Step 2:** Run `npx vitest run src/services/relationshipService.test.ts` → FAIL.
- [ ] **Step 3:** Implement: `inviteOrRequest` calls `supabase.rpc('invite_or_request_relationship',{target_email})`, parse jsonb; `listSentInvites` selects from `relationship_invites` where status='pending'; `cancelInvite` deletes by id. Keep tier0 guards.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit.

### Task 3: UI — smart box + sent invites

**Files:** Modify `src/components/AddPerson.tsx`; Create `src/components/SentInvites.tsx`; wire into the Manage-people surface that renders `PendingRequests` (find via grep for `<PendingRequests`).

- [ ] **Step 1:** `AddPerson`: call `inviteOrRequest`; on `kind==='invite'` fire `sendInviteEmail(email)` and show "Invite sent — they'll be added to your people automatically when they join."; on `kind==='request'` keep existing copy. Update placeholder to "Their email" (drop "must have a Plannen account").
- [ ] **Step 2:** `SentInvites`: list pending invites (`listSentInvites`) with a Cancel button (`cancelInvite`), styled like `PendingRequests`. Render it next to `PendingRequests`.
- [ ] **Step 3:** Run `npx vitest run` + `npm run build` → PASS.
- [ ] **Step 4:** Commit.

### Task 4: Invite email warmth (optional, low-risk)

**Files:** Modify `supabase/functions/send-invite-email/index.ts` + `_shared/handlers/send-invite-email.test.ts` only if adding inviter name. If the function signature change is non-trivial, SKIP (email already works).

- [ ] Decide during execution; keep change minimal or skip.

### Task 5: Verify, release, deploy

- [ ] **Step 1:** `npx vitest run` + `npm run check:parity` + `npm run build` all green.
- [ ] **Step 2:** `/release patch` — version bump, CHANGELOG, PR, squash-merge, tag, GitHub Release.
- [ ] **Step 3:** Deploy prod: `npx plannen migrate` (applies `relationship_invites` to sb_prod), `supabase functions deploy send-invite-email --project-ref djlktktqcuzyhmwvlnfb` (only if Task 4 changed it), `npx plannen deploy` (web).
- [ ] **Step 4:** Smoke check: confirm migration row in `supabase_migrations`, web build live.
