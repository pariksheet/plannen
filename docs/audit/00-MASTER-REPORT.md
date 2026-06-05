# Plannen UI Audit — Master Report

**Date:** 2026-05-18
**Worktree:** `.worktrees/plannen-ui` (branch `feat/plannen-ui`, rebased onto `main@1793298`)
**Method:** seven parallel static-analysis agents — six over feature areas of `src/`, one running the build/test toolchain. No source files were modified. Detailed per-area files live alongside this one in `docs/audit/01-…` through `07-…`.

> **Update log**
> - Initial audit (1st run) ran against `36de91f` — main at session start.
> - While the audit was running, PR #16 merged to main, advancing the baseline by 27 commits (mostly CLI + tier-2 work, but `a1a9f90 feat: tier-0 web-UI signup / identity switch via POST /api/me` lands directly on auth/shell — the same surface audit 06 flagged as a dead-end).
> - After user prompt, the worktree was rebased onto current main (`1793298`) and **audit 06 was re-run**. Other audits remain valid against the new baseline (the diff did not touch their files). See §7 for what changed.

---

## 1. Executive summary

The Plannen web UI **renders cleanly, builds green, and the happy path for an event-centric solo user is largely intact** (MyFeed list, calendar grid, event create form, story rendering, multi-language pills, Settings BYOK key entry, route map). But underneath the surface there is a **large layer of half-implemented multi-user functionality** — friends, groups, invites, RSVPs, email-invites, share-with-user-IDs — that today shows real UI affordances backed by **service-layer stubs that silently return empty or report success while doing nothing**. This is the dominant failure mode of the app and the dominant theme of every per-area audit.

> **Re-framing note (2026-05-18):** the user has decided that Tier 1 and Tier 2 are full multi-user SaaS — the half-implemented social UI is **unfinished work, not cruft**. Tier B items below are therefore mostly "finish in Tier 1+ / hide or no-op in Tier 0", not "delete". See [memory: `project_deployment_model`].

A second, smaller theme: **the user has no path to certain core flows from the web UI alone.** Story creation requires "ask the agent." Profile facts are written by passive extraction but never surfaced. WhatsApp share constructs a `wa.me` URL whose link target is the app root (no `/events/:id` route exists). These are not bugs in components — they are missing UI surfaces.

A third theme is **test-signal rot**: three vitest suites (EventCard, MyStories, memoryService) fail to even load because `tests/setup.ts` doesn't stub the supabase env vars, so their coverage is silently zero while CI stays green.

**Bottom line:** the redesign work in this worktree should not be a pure visual reskin. Before (or alongside) any new design language, the team needs to decide **which half-built multi-user features to delete and which to finish**, and to plug the create-story / WhatsApp-deep-link / profile-facts gaps in the UI. The visual treatment is downstream of those scope decisions.

---

## 2. Cross-cutting themes

### A. Service-layer stubs lying to the UI
At least nine service functions return empty / null / no-op while the UI calling them behaves as if success. Identified instances:
- `inviteService.getInviteByToken` / `joinEventByInvite` — return null/error; `/invite/:token` always shows "Invalid or expired link" (02)
- `appAccessService.inviteEmailToApp` — no-op; InviteToApp UI claims success (02, 06)
- `eventService.setEventSharedWithGroups` — no-op stub (01, 02)
- `eventService.getEventSharedWithUserIds` — hard-coded `{ data: [], error: null }` (01, 02)
- `relationshipService.sendRelationshipRequest` — returns the literal string `"sendRelationshipRequest is not supported in this backend version"` which the AddFamilyMember form surfaces to the user (03)
- `viewService.getFamilyEvents` / `getFriendsEvents` / `getGroupsEvents` — return empty arrays (04)
- `rsvpService.getRSVPs` — returns empty buckets, so every event card shows "No RSVPs yet" regardless of state (01)
- `relationshipService.getMyFriends` / `getMyFamily` — return placeholder rows with `null` names, so pickers render raw UUIDs (01, 04)
- Group rename / delete / member-toggle — silent no-ops in `groupService` (04)

### B. Unfinished multi-user surfaces (Tier 1+ SaaS work)
**Updated 2026-05-18:** Tier 1 and Tier 2 are now scoped as full multi-user SaaS ([memory: `project_deployment_model`]). The half-implemented UI below is **unfinished SaaS work**, not cruft from a previous era. Tier 0 stays single-user; the same surfaces should hide or no-op there.
- `MyFamily`, `MyFriends`, `MyGroups` tabs and their feeds (04) — need real backends in Tier 1+
- `AddFriend`, `PendingRequests`, `ManageGroups` mutate paths (04) — need real relationship/group services
- `EventInviteModal`, `InviteToApp` (02) — need real invite-link redemption + email-invite
- `Login` page reachable from sign-out: Tier-0 fixed via `POST /api/me`; Tier 1+ should use Supabase GoTrue (verify post-rebase)
- RSVP model exists end-to-end in DB but UI hardcoded empty (01); RSVP becomes a real feature in Tier 1+

Decision needed per surface: **finish in Tier 1+** is the default; the question is sequencing and what to hide vs. no-op in Tier 0.

### C. Phantom writes from helper code
`setPreferredVisitDate` (`src/services/rsvpService.ts:58-63`) defaults `currentStatus` to `'maybe'` when no RSVP exists, then upserts. `EventForm.tsx:329-341` calls it on every create/edit that carries a visit date. Net effect: **every event the user creates auto-receives a "Maybe" RSVP from themselves** that they never set. Then the card renders that Maybe badge back at them. (01)

### D. Deep-link blindness
WhatsApp share message (`src/utils/whatsappShare.ts:38`) appends `View in Plannen: ${APP_URL}` — there is **no `/events/:id` route** in `AppRoutes.tsx`. So even if a recipient opens the link, they land on the dashboard root. `VITE_APP_URL` also defaults to `http://localhost:4321` everywhere, so any unset build ships localhost URLs in shared messages. (02)

### E. Form state seeded once, never resynced
All four profile section components (`ProfilePersonalInfo`, `ProfileFamilyMembers`, `ProfileInterestsGoals`, `ProfileLocations`) initialise local form state from props on first render only, with no `useEffect` resync. External updates (e.g. a Claude session writing via `update_profile` while the page is open) stay invisible until reload. (03)

### F. Missing UI for backend capabilities that already exist
- `create_story` — no button anywhere in `src/`. MyStories tells users to "ask the agent." (05)
- `transcribe_memory` — audio uploads exist; DB columns `transcript` / `transcript_lang` / `transcribed_at` exist; **no UI ever calls the tool or reads the columns**. (05)
- `profile_facts` (passively extracted by the plugin) — zero UI surface. User cannot view, audit, or correct what's been inferred about them. (03)

### G. Test signal hole
`tests/components/EventCard.test.tsx`, `tests/components/MyStories.test.tsx`, `tests/utils/memoryService.test.ts` all throw at module-import because `src/lib/supabase.ts:28` requires `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` and `tests/setup.ts` never stubs them. The other 21 suites (264 tests) pass green. EventCard and MyStories are two of the most user-visible components in the app and have **zero coverage** despite the suite files existing. (07)

### H. Build & typecheck are healthy
Single 661 kB JS bundle (one chunk-size warning — no code splitting yet). No TS errors. No ESLint configured at all. Playwright has one Tier-0 smoke spec (2 tests). (07)

---

## 3. Per-area headlines

| # | Area | File | Status | Top finding |
| - | --- | --- | --- | --- |
| 01 | Event lifecycle | `01-event-lifecycle.md` | Mixed | `setPreferredVisitDate` auto-creates phantom Maybe RSVPs on every create/edit |
| 02 | Sharing / WhatsApp | `02-sharing-whatsapp.md` | Broken in three places | Invite-link redemption + email-invite + share-with-users all stubbed; WhatsApp link points to app root |
| 03 | Profile | `03-profile.md` | One broken, several risky | `AddFamilyMember` surfaces internal error string; no resync on external prop change; profile_facts invisible to user |
| 04 | Feeds & social | `04-feeds-social.md` | Largely dead | Family / Friends / Groups event feeds are literal `return []` stubs; mutations no-op silently |
| 05 | Stories & memories | `05-stories-memories.md` | Read works, write doesn't | No `create_story` button in UI; `transcribe_memory` unused; multi-language pills work correctly |
| 06 | Shell / auth / settings | `06-shell-auth-settings.md` | Routes clean, dead-ends in auth | Tier-0 `/login` is reachable but dead; `hasAppAccess` round-trip on every protected mount |
| 07 | Build / tests | `07-build-and-tests.md` | Green, but signal hole | 3 vitest suites fail to load (missing supabase env stubs); no lint; dev smoke blocked by other worktree on :4321 |

Each file contains the full component table, flow-by-flow walkthrough, evidence with `file:line` references, and an "Open questions" section listing things the main session should resolve.

---

## 4. Prioritized backlog

### Tier A — must fix before any UI redesign ships (user-visible bugs)

1. **Phantom Maybe-RSVPs on every event create/edit.** Either remove the `setPreferredVisitDate` auto-RSVP behaviour, or accept that solo-mode RSVPs are meaningless and rip the whole RSVP model out. *Source: 01-event-lifecycle*
2. **AddFamilyMember surfaces `"sendRelationshipRequest is not supported in this backend version"` as a user error.** Wire the form to `add_family_member` directly (or to the MCP tool of the same name). *Source: 03-profile*
3. **WhatsApp share link target.** Either add a public `/events/:id` route and put it in the share message, or change the message to omit the link entirely. *Source: 02-sharing-whatsapp*
4. ~~**Tier-0 `/login` dead-end.**~~ **FIXED** by `a1a9f90` (PR #16). The new `POST /api/me` endpoint provides a real Tier-0 identity flow. Replaced by item 4a below — same surface, different bug.
4a. **Tier-0 identity switch silently orphans the previous user's data.** `POST /api/me` calls `signupOrSwitch(email)` which idempotently inserts a new `auth.users` + `plannen.users` row and **switches the backend identity singleton with no confirmation**, no list of existing identities, no UI affordance for "switch back". The old user's data stays in the DB but becomes unreachable from the UI. Also: sign-out lands the user on the new form labelled "Sign in with Email", which reads as a sign-in surface but is in fact an identity-switcher. *Source: 06-shell-auth-settings (LN-02, LN-03)*
5. **CoverPicker and StoryPhotoStrip silently drop Google-Photos-sourced memories** because both filter on `media_url IS NOT NULL`. Decide whether to render those memories without a thumb or to use the GP proxy URL. *Source: 05-stories-memories*
6. **Vitest setup missing supabase env stubs** — three suites silently skip. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` stubs to `tests/setup.ts`. *Source: 07-build-and-tests*
7. **`VITE_APP_URL` defaults to `http://localhost:4321` in production builds.** Either fail the build if unset, or omit the URL fragment when it's localhost. *Source: 02-sharing-whatsapp*

### Tier B — finish in Tier 1+ (decision now made — see §0 re-framing note)

8. **Multi-user social surface.** `MyFamily`, `MyFriends`, `MyGroups`, `AddFriend`, `PendingRequests`, `ManageGroups`, `EventInviteModal`, `InviteToApp`, `EventShareModal`'s pickers. **Finish in Tier 1+**: real backends for friend requests, group membership, shared-event ACLs. In Tier 0: hide tabs/buttons or solo-no-op. *Source: 02, 04*
9. **Invite-link redemption.** `inviteService.getInviteByToken` / `joinEventByInvite`. **Finish in Tier 1+**: token model in DB, redeem endpoint, post-redeem auth flow (sign-up if new user). In Tier 0: hide `/invite/:token` and `InviteJoin`. *Source: 02-sharing-whatsapp*
10. **RSVP system.** **Keep — core SaaS feature.** Wire `RSVPList` to real data in Tier 1+. Tier 0 degenerates to self-RSVP only; the `setPreferredVisitDate` phantom-Maybe bug (Tier A #1) still needs fixing in both tiers. *Source: 01-event-lifecycle*
11. **Email-invite flow** (`InviteToApp` → `inviteEmailToApp` → `send-invite-email` edge function). **Finish in Tier 1+**: Mailgun (or alt) wired, token-bearing magic-link email, redeem-on-click. In Tier 0: hide the surface. *Source: 02, 06*

### Tier C — polish / quality (good redesign hygiene)

12. **Profile section form-state resync** — `useEffect` on prop change in all four section components. *03*
13. **Profile facts read/edit UI** — passive extraction is invisible. *03*
14. **Full-name rename path post-onboarding** — currently no UI path exists. *03*
15. **Replace raw UUIDs with names** in family/friends/groups lists. *04*
16. **N+1 RSVP fetch in MyFeed** — `getPreferredVisitDates` fans out one request per event (up to 500). *04*
17. **MyGroups past-events sort** — violates the bottom-up Facebook-scroll rule used in MyFeed/MyFamily/MyFriends. *04*
18. **`MemoryImage` lazy loading + shared cache** — currently one `fetch`+`createObjectURL` per tile. *05*
19. **`AgentChat` rename** — it's a single-shot discovery form, not a chat. *05*
20. **Story-language picker location** — currently in `/settings`, semantically belongs in `/profile`. *05*
21. **`Modal` focus trap** — missing today. *06*
22. **`ProtectedRoute` `hasAppAccess` optimisation** — round-trip on every mount, no-op in Tier-0. *06*
23. **Settings note clarifying BYOK key scope** — per [memory: `feedback_byok_key_scope`], the field should say it's web-UI-only. *06*
24. **Code splitting** — single 661 kB bundle, one chunk-size warning. *07*
25. **ESLint configuration** — none today. *07*
26. **Catch-all 404 route**. *06*

---

## 5. New findings from the rebase re-audit (audit 06 only)

These are introduced by `a1a9f90` (the Tier-0 identity / `POST /api/me` work merged after the first audit). Full detail in `06-shell-auth-settings.md`.

- **[RISKY] LN-01 — `POST /api/me` is unauthenticated.** No origin check, no shared secret, no caller authentication. Any local process can swap identity and rewrite `.env`. Acceptable threat model for Tier 0 (loopback only) but **unsafe in Tier 2 unless additional protections land**.
- **[RISKY] LN-02 — Silent identity orphaning** (also Tier A #4a above).
- **[RISKY] LN-03 — Sign-out / identity-switch labelling.** Sign-out is still a no-op in Tier 0 (no GoTrue session to clear) but now drops users on `/login` which is actually an identity-switcher labelled "Sign in with Email". Discoverability trap — a returning user looks like they need a credential.
- **[MINOR] LN-04 — `auth.users` insert bypasses GoTrue.** New row created directly in the auth schema overlay, which works in Tier 0 (stubbed auth) but won't roundtrip correctly if the user later moves to Tier 1.
- **[MINOR] LN-05 — `rewriteEnv` regex sanitization is over-aggressive.** Quoted email values get their quotes stripped on rewrite.
- **[MINOR] LN-06 — `.env` persist silently skips when `PLANNEN_ENV_PATH` is unset.** Identity switch then loses persistence on backend restart.
- **[MINOR] LR-04 — Duplicate profile-write in `AuthContext`.** New code writes the profile both via `dbClient.profile.update` and via the `POST /api/me` server side.

The original audit 06 findings other than LB-01 (the dead-end Login form, now fixed) all remain.

## 6. What I did NOT verify (open questions for the main session)

- **No dev-server smoke in this worktree.** Port 4321 is held by another worktree's dev server (Vite `strictPort`). The build is clean but I did not actually load the running app in a browser to compare against my static findings. Recommend running the redesign branch on a free port (or stopping the other worktree's dev server) and clicking through.
- **No Playwright run.** One Tier-0 smoke spec exists (`tests/e2e/tier0-smoke.spec.ts`); I inventoried it but did not execute.
- **Backend endpoint inventory.** Each per-area agent traced UI → service. I did not separately inventory `backend/src/routes/api/` to verify which endpoints exist server-side and which are missing.
- **Tier-1 behaviour.** All audits were against Tier-0 reality (since that's the current default). Some "stub" findings may be Tier-0-specific and have working Tier-1 paths. The Tier-1 path was checked spot-wise (notably in 03-profile) but not exhaustively.
- **Per-component `Open questions` sections** in files 01-06 each list 2-5 things the agents could not determine from static analysis. Worth a skim before the redesign brainstorm.

---

## 7. What changed since the first run (rebase reconciliation)

Files actually changed by the 27-commit catch-up (filtered to UI-relevant):

| File | Δ | Audit areas affected |
| --- | --- | --- |
| `src/context/AuthContext.tsx` | +28 lines | 06 |
| `src/pages/Login.tsx` | +29 lines | 06 |
| `src/lib/dbClient/{tier0,tier1,types}.ts` | +9 lines | 06 (indirect) |
| `backend/src/auth.ts` | new (39 lines) | 06 |
| `backend/src/routes/api/me.ts` | new (54 lines) | 06 |
| `backend/src/_shared-overlay/{identity,rewriteEnv,rewriteEnv.test}.ts` | new | 06 |
| `backend/src/index.ts` | +15 lines | 06 |

Everything else changed in the range is CLI / bootstrap / CI / docs / tier-2 deploy plumbing — none of it touches UI source.

**Therefore:** audits 01, 02, 03, 04, 05, and 07 remain valid against the new baseline; only audit 06 was re-run. Tier B and Tier C of the backlog are unchanged.

## 8. Suggested next step

When you return, I'd recommend a short call to:

1. **Resolve Tier B scope decisions** — they cascade into the visual redesign. A redesigned `MyFamily` tab is only worth doing if the tab is going to exist.
2. **Triage Tier A fixes** — pick which to land in this worktree before redesign work begins, vs. which to defer.
3. **Then** brainstorm the visual/IA redesign with the now-confirmed feature set.

I'll wait for your read on this report before touching code.
