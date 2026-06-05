# Analysis: "Treat family as a special group, unify the data model"

**Branch:** `feat/treat-family-as-specail-group`
**Status:** Analysis only — no code changed.
**Author:** Claude, 2026-05-20.

---

## Your thesis, restated

> Why do we have separate database tables and special code paths for family? If family is just a special group, sharing and other things become unified — we don't need a separate data model.

My short answer: **the direction is right, but the thesis is conflating two different things that should be split apart.** One half is an easy, high-value cleanup. The other half is harder and may not actually be worth it.

---

## What the schema actually looks like today

I read the consolidated schema (`supabase/migrations/00000000000000_initial_schema.sql`) and the MCP/edge function code. The "family" concept is split across **three different mechanisms**, not one:

### 1. `family_members` table — *offline contacts*
- Lines 563–574 of the schema.
- Stores **people who don't have a Plannen account**: kids, partners, grandparents.
- Columns: `name`, `relation`, `dob`, `gender`, `goals[]`, `interests[]`.
- They have no `auth.users` row. They cannot log in. They cannot RSVP.
- They exist so the briefing can say "Aarav has soccer practice" and so profile facts can attach `subject = <family_member_uuid>`.

This is **not a group**. It is a contact book of offline people you care about. The word "family" is misleading — there's no constraint that says these have to be family. The `relation` column is a free-text string.

### 2. `relationships` table — *user-to-user edges between real accounts*
- Lines 632–646.
- Two real Plannen users connected via `relationship_type ∈ {family, friend, both}`, with status `pending|accepted|blocked`.
- This is **already** a group-shaped abstraction with a type field.

### 3. `friend_groups` + `friend_group_members` + `event_shared_with_groups` — *generic group machinery*
- Lines 580–596 and 471–475.
- Fully generic: a group has a name, members are real users, events can be broadcast to a group.
- Nothing in the schema prevents a `friend_groups` row from being called "Family". The "friend" naming is cosmetic.

### 4. `events.shared_with_family` — *a single boolean broadcast flag*
- Line 538.
- When true, the event is visible to anyone with an `accepted` relationship of type `family` or `both`.
- This is the **one** place in the data model where "family" is hardcoded as a distinct sharing axis, parallel to the generic group-sharing path.

---

## The four real places where code branches on family

1. **`shared_with_family` boolean on events.** RLS at lines 1418–1422 checks the `relationships` table for `relationship_type IN ('family', 'both')`. There is a *parallel* generic group path (`event_shared_with_groups`). Two ways to do the same thing.

2. **`EventShareModal.tsx` UI.** Separate state for `sharedWithFamily` (checkbox) vs. `sharedWithGroupIds[]` (multi-select). Two save paths.

3. **`get_briefing_context`** (`supabase/functions/mcp/tools/briefings.ts:72–75`). Hardcoded SQL: `SELECT … FROM plannen.family_members WHERE user_id = $1`. The "inner circle" Claude sees in the morning briefing is literally and only the `family_members` table.

4. **`get_profile_context`** (`supabase/functions/mcp/tools/profile.ts:78–80`). Same pattern. The `family_members` array is returned to Claude as a top-level field. Friend groups are not.

---

## Splitting your thesis into two questions

Your single sentence is really two design questions, and they have different answers.

### Question A — Should `shared_with_family` boolean become a group?

**Yes.** This one is a clear win.

- Today: one boolean on every event, plus a separate group-share table for everything else.
- After: family is a system-managed group called e.g. "Family". `events.shared_with_family` goes away. The UI has one consistent "share with group(s)" picker.
- RLS simplifies — one path, not two.
- Migration is straightforward: for each user, create a `friend_groups` row tagged as their family group, populate it from `relationships` where type IN ('family','both'), and rewrite every event with `shared_with_family=true` into `event_shared_with_groups` linking that group.
- Cost: one migration, a small UI change, deleting one boolean column and ~30 lines of RLS.

### Question B — Should `family_members` (offline contacts) be merged into users/groups?

**Probably not, or at least not yet.** This is where the unification thesis breaks down.

- `family_members` are not users. They have no auth row, no session, no inbox. They can't be granted access to anything because there's no "they" to grant access to.
- The thing they're really used for is **a place to hang profile facts and pre-load briefing context**. That's a contact-book role, not a group role.
- To unify, you'd have to introduce a "contact type" union ({offline_person, real_user, group}) and propagate it through `profile_facts.subject`, `briefings`, `stories`, etc. That's a cross-cutting change for a payoff that's mostly aesthetic.
- The simpler reframing is: **`family_members` is an offline contact book. It happens to be called "family" for historical reasons. Don't unify it with groups — just stop pretending the name is structural.**

### Question C (the one hiding underneath A and B) — What is the "inner circle" for context?

The briefing and profile context layers hardcode `family_members` as **the** inner circle. That's the real coupling.

- The right abstraction is probably: **users can mark one or more groups as "inner circle" for briefing context**.
- Default for a single-family household: the auto-generated Family group.
- This decouples "who do I want pre-loaded into Claude's context" from "what table stores offline kids' birthdays."
- That's where you actually get the multi-family / co-parenting / chosen-family flexibility, without touching the contact storage.

---

## My recommendation

Phase the work, biggest leverage first:

**Phase 1 — Unify event sharing (Question A).** Migrate `shared_with_family` into a system-managed "Family" group per user. Single share path, single UI, RLS simplifies. Low risk, high clarity. **Do this first.**

**Phase 2 — Introduce "primary circle" config (Question C).** Add a per-user `primary_circle_group_ids` (probably defaults to the Family group). Rewrite `get_briefing_context` and `get_profile_context` to pull from the primary circle instead of hardcoding `family_members`. Now the briefing layer is no longer family-aware — it's circle-aware. This is the actual generalization win.

**Phase 3 — Decide on `family_members` (Question B).** With Phase 1 and 2 done, look again. My guess: you'll find `family_members` is just "offline contacts attached to your account" and the right move is to **rename it to `contacts` or `offline_people`** rather than fold it into the group/user machinery. Renaming is cheap; merging is expensive. But this decision becomes much clearer once the sharing and briefing layers are no longer leaning on it.

---

## Where your instinct is right and where I'd push back

**You're right that:**
- There's duplicated machinery for "share with family" vs "share with a group". The boolean is a wart.
- The hardcoding in briefing/profile context to `family_members` is a real coupling and limits multi-circle scenarios.
- The naming ("friend_groups" vs "family_members") is misleading and implies more structural difference than actually exists.

**I'd push back on:**
- Treating this as one decision. The sharing-unification (Phase 1) is obvious; the contact-storage unification (Phase 3) is not.
- Assuming "family is a group" implies `family_members` should disappear. Groups have members who are users. Offline kids aren't users. Forcing them to be groups means either (a) inventing fake user rows, or (b) introducing a contact-type union — both worse than keeping a contact table.
- Doing the whole thing in one branch. This is a tier-0 / tier-1 / tier-2 cross-cutting change touching RLS, edge functions, MCP, and the frontend. Phase it.

---

## What this branch should hold

Right now: just this document.

When you're back, if you agree with the framing, the next concrete step is probably a written spec under `docs/superpowers/specs/` for Phase 1 (event-sharing unification) — that's the one with the clearest scope and biggest payoff. Phase 2 deserves its own spec after Phase 1 lands.
