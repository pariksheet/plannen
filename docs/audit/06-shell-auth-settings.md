# Audit 06 — Shell / Auth / Settings (re-run after `a1a9f90`)

Scope: outer scaffolding of the React 18 + react-router-dom 6 web app — entry
point, route map, auth context, settings context, protected route gating, top
navigation, modal primitive, backend-tier badge, the legacy multi-user
artifacts (`InviteJoin`, `Privacy`), and — new in this re-run — the
Tier-0 web-UI signup / identity-switch surface (`POST /api/me`).

Evidence comes from the worktree at
`/Users/stroomnova/Music/plannen/.worktrees/plannen-ui` (read-only). Re-audit
baseline is HEAD after merge of PR #16 (`1793298`); the auth-relevant commit
is `a1a9f90 feat: tier-0 web-UI signup / identity switch via POST /api/me`.

## What changed since the prior audit

The original audit 06 was performed against `36de91f`. Since then:

- `a1a9f90` introduced a real Tier-0 sign-in path through `POST /api/me`.
- The middleware in `backend/src/index.ts` was rewritten to read the active
  user from a mutable identity singleton on every request, replacing the
  captured `const` from boot.
- `Login.tsx` was rewired from "submit always errors" to a working
  signup / identity-switch form prefilled with the current profile email.
- `AuthContext.signIn` (Tier 0 branch) now calls `dbClient.me.signup` and
  mirrors the resolved user back into context state.
- `dbClient.me` gained `signup(email)`; the Tier 1 impl explicitly throws
  ("tier-0 only") so callers can't misuse it.
- Two new backend modules: `backend/src/_shared-overlay/identity.ts` (mutable
  singleton) and `backend/src/_shared-overlay/rewriteEnv.ts` (+ unit tests).
- `scripts/backend-start.sh` now exports `PLANNEN_ENV_PATH=$REPO/.env`
  so the backend knows where to persist `PLANNEN_USER_EMAIL` after a switch.
- The PR #16 merge (plannen CLI) is unrelated to auth/shell — no shell-side
  changes there.

### Status of each prior finding

| ID | Prior finding | Status |
|----|----|----|
| LB-01 | Tier-0 `/login` is a dead-end form | **FIXED** — Login submit now invokes `dbClient.me.signup` → `POST /api/me`, returns a real user, navigates to redirect target. See `Login.tsx:25-45` and `AuthContext.tsx:147-175`. |
| LB-02 | `/auth/callback?error=invalid_link` is not surfaced on Login page | **STILL PRESENT** — `Login.tsx` still doesn't read the `error` query param. Tier-1 only. |
| LR-01 | `hasAppAccess()` round-trip on every protected-route mount | **STILL PRESENT** — `ProtectedRoute.tsx:14-24` is unchanged. The check still fires on every `<ProtectedRoute>` mount. Tier 0 still short-circuits via `isLocal()` in `appAccessService.ts:10`; Tier 1 still makes an extra `me.get()` round-trip. |
| LR-02 | `appAccessService.inviteEmailToApp` is a silent no-op | **STILL PRESENT** — `appAccessService.ts:23-28` is unchanged. |
| LR-03 | `BackendBadge` reveals Supabase URL in DOM | **STILL PRESENT** — `BackendBadge.tsx` is unchanged. |
| LM-01 | Modal has no focus trap | **STILL PRESENT** — `Modal.tsx` unchanged. |
| LM-02 | Dashboard `?view=` routing inconsistent with `/profile` | **STILL PRESENT**. |
| LM-03 | No catch-all `*` route | **STILL PRESENT** — `AppRoutes.tsx` unchanged. |
| LM-04 | `/` route reads `window.location` at render time | **STILL PRESENT** — `AppRoutes.tsx:51`. |
| LM-05 | Settings header doesn't restate "this key only powers the web UI" | **STILL PRESENT** — `Settings.tsx:145-148` unchanged. |
| LM-06 | `SettingsContext.useEffect` for `system` is not StrictMode-guarded | **STILL PRESENT** — `SettingsContext.tsx:72-76`. |
| LM-07 | `Privacy` "Back to Plannen" link routes through `/dashboard` redirect chain | **STILL PRESENT**. |
| LM-08 | `TIER` constant duplicated across 12 files | **STILL PRESENT** — `grep` confirms 12 files still declare it inline. |
| LM-09 | `Navigation` doesn't show active state for `/profile` or `/privacy` | **STILL PRESENT**. |

### Net delta

One prior critical finding fixed (LB-01). All others unchanged. Two **new**
findings emerge from the identity-switch design (see LN-01, LN-02 below).
Two **upgraded** items: the Tier-0 sign-out flow (Open Question 8 in the
prior audit) is now demonstrably broken in a new way (LN-03), and LR-01 is
worth re-stating because `POST /api/me`'s success path bypasses the
"loading…/Checking access…" gate (cosmetic).

## Summary

- The shell structure is unchanged from the prior audit: `main.tsx` →
  `<StrictMode><App/></StrictMode>` → `AuthProvider` → `SettingsProvider` →
  `BrowserRouter` → `AppRoutes` + fixed `BackendBadge`. No service worker,
  no global side-effects beyond Tailwind + Inter.
- Route map is **unchanged** — same eight routes (`/login`, `/auth/callback`,
  `/privacy`, `/invite/:token`, `/dashboard`, `/onboarding`, `/profile`,
  `/stories/:id`, plus the `/` redirect). Verified `git diff` does not touch
  `AppRoutes.tsx`.
- The Tier-0 `/login` page is now **functional**: it prefills the email
  from `profile.email` (or stays blank if AuthContext hasn't resolved yet),
  submits to `dbClient.me.signup(email)`, which calls `POST /api/me`,
  which inserts/resolves rows in `auth.users` + `plannen.users`, mutates
  the backend identity singleton, and best-effort persists
  `PLANNEN_USER_EMAIL=<new email>` to `.env`. On success the page
  navigates to the redirect target (or `/`).
- Sign-out (`AuthContext.signOut`) is still a **no-op in Tier 0**, but
  `Dashboard.handleSignOut` still navigates to `/login` afterward. Net
  effect: clicking "Sign out" now lands the user on a *working* Login page
  prefilled with their own email — which is better than the prior
  dead-letter UI but is still semantically confusing (it looks like a
  sign-in form, not a "switch identity" form). See LN-03.
- `ProtectedRoute` is **unchanged** — `hasAppAccess()` still fires on every
  protected-route mount, still a no-op in Tier 0, still an extra round-trip
  in Tier 1.
- The Tier-0 identity model is now a **mutable singleton in the backend
  process**, persisted to `.env` for restart-survival. There's no
  per-request identity (no JWT, no cookie) — every request reads from
  `getIdentity()` in the middleware. This is sound for a single-user local
  deployment but worth documenting because the security model is "trust
  loopback + filesystem" rather than "trust signed request".

Top three findings (re-ordered for the new code):

1. **[FIXED]** Tier-0 Login is wired end-to-end (was LB-01). The submit
   button no longer errors. The Login UI is the primary path for
   "switch which local user this Plannen install thinks I am".
2. **[NEW / RISKY]** `POST /api/me` has no auth gate. Anyone who can reach
   `localhost:54323` (or the proxied `localhost:4321`) can swap the active
   identity by POSTing a JSON email. In Tier 0 the gate is "you're on the
   local machine" (no CORS, no origin check, no shared secret). For a
   single-user local-only app this matches the threat model — but it means
   any other process on the same machine (or any rogue browser tab) can
   silently switch the identity *and rewrite `.env`*. See LN-01.
3. **[NEW / RISKY]** Switching identity orphans the previous user's data
   in place. `signupOrSwitch` creates new rows; it does not move, hide,
   or label the prior user's events / memories / stories. The UI gives
   no indication that there are *other* `plannen.users` rows in the same
   DB. See LN-02 for the contract surface.

## Route map

Every path in `src/routes/AppRoutes.tsx` (verified unchanged since prior
audit — `git log --oneline 36de91f..HEAD -- src/routes/AppRoutes.tsx`
returns no commits):

| # | Path                  | Component              | Auth gate         | Notes |
|---|-----------------------|------------------------|-------------------|-------|
| 1 | `/login`              | `Login`                | Public            | **Now works in Tier 0** — submit calls `signIn` → `dbClient.me.signup` → backend `POST /api/me`. In Tier 1 still the magic-link form. |
| 2 | `/auth/callback`      | `AuthCallback`         | Public            | Tier 1: verifies `token_hash`+`type`. Tier 0: short-circuits to `/dashboard`. Unchanged. |
| 3 | `/privacy`            | `Privacy`              | Public            | Unchanged. |
| 4 | `/invite/:token`      | `InviteJoin`           | Public (bounces to `/login` if unauth) | Unchanged. |
| 5 | `/dashboard`          | `Dashboard`            | `ProtectedRoute`  | Sub-views via `?view=`. Unchanged. |
| 6 | `/onboarding`         | `Onboarding`           | `ProtectedRoute`  | Tier-1 only (Tier 0 doesn't auto-trigger). Unchanged. |
| 7 | `/profile`            | `Profile`              | `ProtectedRoute`  | Unchanged. |
| 8 | `/stories/:id`        | `StoryReader`          | `ProtectedRoute`  | Unchanged. |
| 9 | `/`                   | `Navigate to /dashboard?…` | Public        | Unchanged. |

Still no catch-all `*` route (LM-03). Eight component imports still resolve
cleanly.

The new `POST /api/me` route is a **backend** route, not a frontend
react-router route — it's registered in `backend/src/index.ts:74`
(`app.route('/api/me', me)`) and proxied through Vite to `localhost:54323`.
The frontend reaches it via `dbClient.me.signup` / `dbClient.me.get` only.

## Components reviewed (delta-focused)

Tables below show only the components touched since the prior audit, plus
any whose behaviour materially changes because of the auth-singleton model.

| File | Lines | Change since prior audit | Notes |
|------|-------|--------------------------|-------|
| `src/context/AuthContext.tsx` | 203 (was 175) | `signIn` Tier-0 branch rewritten; `loadProfile` Tier-0 branch reuses `dbClient.me.get` payload (was already there). | See LR-04 below — the boot effect now writes `profile` twice on Tier 0 (once in the boot effect, once if `loadProfile` is called via `refreshProfile`). Harmless but inelegant. |
| `src/pages/Login.tsx` | 107 (was 86) | Added `useEffect` to prefill `email` from `profile?.email` on Tier 0 (lines 21-23); added Tier-0 redirect-after-success block (lines 36-42); copy under the button switched to "Local single-user mode — sign in with this email or type a different one to switch identity" (lines 93-97). | Submit handler unified — both tiers go through `signIn` and branch on `TIER === '0'` only for post-success navigation. |
| `src/lib/dbClient/tier0.ts` | 216 (was 215) | One line: `signup: (email) => api('/api/me', { method: 'POST', body: JSON.stringify({ email }) })`. | Identical envelope handling to `me.get`. |
| `src/lib/dbClient/tier1.ts` | 577 (was 574) | Tier 1 `me.signup` throws explicitly with a tier-1-doesn't-do-this message. | Good defensive design. |
| `src/lib/dbClient/types.ts` | 269 (was 264) | `me` block now has `signup(email) => Promise<{ userId, email, full_name?, avatar_url? }>` declared on the `DbClient` interface. | Tier 1 must implement-and-throw to satisfy the interface — done. |
| `backend/src/auth.ts` | **NEW**, 66 lines | New file. Exports `resolveUserAtBoot` (existing logic, moved here) and `signupOrSwitch` (transactional idempotent upsert into `auth.users` + `plannen.users`). | See LN-04 — the `BEGIN/COMMIT` is correctly bracketed; on conflict it bumps `email = EXCLUDED.email` which is a no-op when the email is unchanged but a *real* update when case differs. |
| `backend/src/routes/api/me.ts` | **NEW**, 79 lines | `me.get('/')` (existing logic, now reads `c.var.userId` from the per-request middleware). `me.post('/')` is new. | See LN-01, LN-02. |
| `backend/src/_shared-overlay/identity.ts` | **NEW**, 17 lines | Mutable singleton: `setIdentity` / `getIdentity`. Throws if `getIdentity()` is called before `setIdentity()`. | The "throws" guard means `index.ts` *must* call `setIdentity(bootUser)` before any request lands. Line 49 does this synchronously after `resolveUserAtBoot`, before the first `serve()` call — correct. |
| `backend/src/_shared-overlay/rewriteEnv.ts` | **NEW**, 33 lines | Pure helper. Reads file, splits on `\n`, regex-replaces or appends, writes back. | See LN-05 — the regex sanitization on line 8 is over-aggressive but does not produce wrong output for any real env-var name. |
| `backend/src/_shared-overlay/rewriteEnv.test.ts` | **NEW**, 44 lines | Six vitest cases including empty-file, trailing-newline, substring-collision, comment-preservation. | Coverage looks complete. |
| `backend/src/index.ts` | 114 (was 99) | Middleware reads `getIdentity()` per request (lines 63-71); `bootUser` set into singleton at line 49. Previous version captured `bootUser` in a `const` and used it directly. | See discussion under "Flows reviewed → Identity switch (Tier 0)". |
| `scripts/backend-start.sh` | 45 (was 42) | Exports `PLANNEN_ENV_PATH="$REPO/.env"` at line 18 so the backend can rewrite the file. | If you run the backend by hand without this script, `POST /api/me` still works in-memory but won't persist — see LN-06. |

All other components in the original audit are unchanged.

## Flows reviewed

### App boot

Boot order on a fresh page load with Tier 0 is unchanged in shape — the
`/api/me` GET path is unchanged. The new thing is that the backend's
identity is now read from `getIdentity()` on every request rather than a
captured const. From the frontend's perspective this is invisible.

### Identity switch (Tier 0) — new flow

End-to-end trace of "user types a new email in `/login` and submits":

1. `Login.tsx:30` calls `signIn(email, redirectTo)`.
2. `AuthContext.signIn` (Tier 0 branch, lines 147-175) calls
   `dbClient.me.signup(email)`.
3. `dbClient.me.signup` (`tier0.ts:52`) issues
   `POST /api/me` with body `{ email }` over the same-origin Vite proxy.
4. Vite forwards to `localhost:54323/api/me`. Hono routes to `me.post('/')`.
5. `me.post('/')` (`backend/src/routes/api/me.ts:35-79`):
   - Parses JSON; bails 400 on invalid email.
   - Calls `signupOrSwitch(email)` (`backend/src/auth.ts:35-65`):
     - Opens a pg `BEGIN` transaction.
     - `INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id` — idempotent.
     - `INSERT INTO plannen.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`.
     - `COMMIT`. Returns `{ userId, email }`.
   - Calls `setIdentity({ userId, email })` to mutate the backend singleton.
   - If `PLANNEN_ENV_PATH` is set, calls `updateEnvFile` to rewrite
     `PLANNEN_USER_EMAIL` in `.env`. Best-effort; logs a warning on
     failure but does not fail the request.
   - Re-enters with `withUserContext(resolved.userId, …)`, selects
     `full_name`, `avatar_url`, returns envelope `{ data: { userId, email, full_name, avatar_url } }`.
6. `AuthContext.signIn` receives the payload, synthesises a `User` object,
   calls `setUser(u)` + `setProfile(...)`, returns `{ error: null }`.
7. `Login.tsx:36-42` reads `redirectTo` query param, navigates to the
   target (or `/` if absent) with `replace: true`. The `/` route immediately
   `Navigate`s to `/dashboard`, where `ProtectedRoute` checks the now-set
   `user`, fires `hasAppAccess()` (which short-circuits via `isLocal()`),
   and renders `Dashboard`.

**Notable side-effects:**

- The previous identity's data stays in the DB. New events / memories /
  stories created from now on are owned by the new `userId`. There's no
  "switch back" affordance in the UI — the user would have to type the
  old email again.
- `.env` is rewritten in place. The rewrite preserves line position and
  trailing-newline convention per the rewriteEnv tests.
- HMR-induced effect re-runs in dev are not a problem here because the
  `useEffect` that prefills the email field doesn't trigger
  `dbClient.me.signup` — only the form submit does.

### Sign-in (Tier 1 magic link)

Unchanged from the prior audit. Same Supabase OTP flow:
1. `signInWithOtp({email, options:{emailRedirectTo:…}})`
2. Email link → `/auth/callback?token_hash=…&type=…`
3. `verifyOtp` → `/dashboard`.

`Login.tsx` still does not parse the `error` query param when redirected
from `/auth/callback?error=invalid_link` (LB-02 unchanged).

### Sign-out

`AuthContext.signOut` (lines 186-189) is **unchanged** — Tier 0 returns
without doing anything; Tier 1 calls `supabase.auth.signOut()`. The
caller in `Dashboard.handleSignOut` (lines 59-62) calls `signOut()` then
`navigate('/login', { replace: true })`.

In Tier 0 the net effect is: the click does nothing on the backend (the
identity singleton is unchanged), `user` in context stays populated,
and the user is shown the Login page prefilled with their own email. This
is **less broken** than the prior dead-end but is still confusing — the
prior audit's Open Question 8 ("Does the user need a sign-out affordance
in Tier 0?") becomes more urgent now that the page they land on is a
real form: a casual user might type a different email here thinking
they're "signing in elsewhere" and accidentally swap identity. See LN-03.

### Onboarding

Unchanged. Still Tier-1 only. `Onboarding.tsx` self-redirects if
`profile.full_name` is set.

### Protected route gating

Unchanged. Still four gates in `ProtectedRoute.tsx`:

1. `loading` → spinner.
2. `!user` → `<Navigate to="/login" />`.
3. `useEffect` runs `hasAppAccess()`; pending → "Checking access…"; false →
   invite-only screen.
4. `TIER==='1' && !profile.full_name && pathname !== '/onboarding'` →
   `<Navigate to="/onboarding" />`.

LR-01 still applies.

### Settings — BYOK key entry

Unchanged. See prior audit body. LM-05 still applies.

### Backend badge accuracy

Unchanged. LR-03 still applies.

## Issues found

### [BROKEN]

#### LB-02 — `/auth/callback?error=invalid_link` is not surfaced
*File:* `src/pages/Login.tsx`

Same as prior audit. Not affected by the new code (Tier-1-only path).

### [RISKY]

#### LN-01 — `POST /api/me` has no caller authentication

*File:* `backend/src/routes/api/me.ts:35-79`, `backend/src/index.ts:63-71`

The route accepts any JSON body with an `email` string and will:
1. Insert a new `auth.users` row if the email is new (using
   `gen_random_uuid()` — no auth signature).
2. Insert a corresponding `plannen.users` row.
3. **Mutate the backend's global identity singleton.**
4. **Rewrite `PLANNEN_USER_EMAIL` in `.env` on disk.**

There is no CORS gate on this route, no origin check, no shared secret,
no cookie verification. The Hono server is bound to `127.0.0.1` only
(`backend/src/index.ts:41`) so it's not exposed over LAN, but **any
process on the local machine** (including arbitrary browser tabs that
happen to be open against `localhost`) can swap the active Plannen
identity and persist that change to `.env`. The corsMiddleware
(`backend/src/middleware/cors.ts` — not read here, but referenced at line
8 of `index.ts`) controls what cross-origin browser callers can do; for a
*malicious local process* CORS is irrelevant.

For Plannen's stated threat model (single-user local-only app per
[[project_deployment_model]]) this is acceptable — but it should be
*documented* as the threat model, and it should be re-evaluated when /
if Tier 2 (cloud) is exposed. Specifically the body of `me.post` would
need a per-user auth check before being safe in a multi-tenant context.

Mitigations to consider (none required for Tier 0):
- Require `PLANNEN_LOCAL_ADMIN_SECRET` header for `POST /api/me` and put
  the secret in `.env` so the React app reads it from `import.meta.env`
  and other local processes don't have it.
- Or move the rewrite-`.env` side-effect to a separate, opt-in endpoint
  so the "swap identity" call doesn't also touch the filesystem unless
  the caller asks.

#### LN-02 — Identity-switch leaves orphaned data with no UI affordance

*File:* `backend/src/auth.ts:28-65`, `backend/src/routes/api/me.ts:35-79`,
`src/pages/Login.tsx:93-97`

`signupOrSwitch` creates a new `plannen.users` row and binds future
requests to it. The previous user's events / memories / stories / etc.
remain in the DB under the old `user_id` but become **invisible to the
UI** — every list query in `tier0.ts` is implicitly scoped to the
current request's `userId` via `withUserContext`, and the UI offers no
way to enumerate other `plannen.users` rows.

Consequences:
- Typo in the email field on `/login` creates a fresh empty profile.
  The user sees "all my data is gone!" until someone tells them to
  re-type the right email.
- There's no list of historical identities anywhere in the UI. Users
  who deliberately switch to test something can't see what they switched
  *from* without reading the database.
- The `.env` rewrite is silent — no toast, no confirmation step.

Recommend either:
- (Minimum) A confirm modal on `/login` submit when `email !== profile?.email`:
  "You're about to switch from <old> to <new>. Your existing data
  remains in the DB but won't be visible. Continue?"
- (Better) A dropdown of existing `plannen.users` rows on the Login page
  so the user can pick from emails the system already knows about.

#### LN-03 — Sign-out in Tier 0 lands users on an identity-switch form

*File:* `src/pages/Dashboard.tsx:59-62`, `src/context/AuthContext.tsx:186-189`,
`src/pages/Login.tsx`

Clicking the Sign Out icon (top-right of `Navigation`) calls
`AuthContext.signOut` which in Tier 0 returns immediately, then
navigates to `/login`. The user lands on the Login page prefilled with
their own email. Pressing "Sign in with Email" without modification is
benign (idempotent — `signupOrSwitch` resolves to the same row). But:

- If the user types a different email here thinking they're "signing in
  with a different account on this device", they'll create a new
  identity, orphan their data, and rewrite `.env` — all without a
  confirmation step.
- The button label is "Sign in with Email" — which doesn't describe what
  actually happens (identity switch / signup).

Suggested fix: in Tier 0, hide the Sign Out icon in `Navigation` (or
replace it with a "Switch identity" icon that opens a confirm-aware
flow). The current behaviour is a discoverability trap.

#### LR-01 — `hasAppAccess()` round-trip on every protected route (carry-over)

Unchanged from prior audit. `ProtectedRoute.tsx:14-24` still fires
`hasAppAccess()` on every mount. Tier 0 no-op via `isLocal()`; Tier 1
still an extra `me.get()`.

Now that AuthContext is the single source of truth for "am I signed in"
in Tier 0 (`POST /api/me` directly sets it), the value of the second
check in `ProtectedRoute` is strictly negative — every protected-route
mount shows the "Checking access…" pane for one tick before falling
through. Cosmetic but worth fixing.

#### LR-02 — `appAccessService.inviteEmailToApp` silent no-op (carry-over)

Unchanged.

#### LR-03 — `BackendBadge` DOM-leaks Supabase URL (carry-over)

Unchanged.

### [MINOR]

#### LR-04 — AuthContext writes `profile` twice in the Tier-0 boot path

*File:* `src/context/AuthContext.tsx:92-122` and `31-81`

The Tier-0 boot effect (`useEffect`, lines 92-122) directly calls
`setProfile(...)` after `dbClient.me.get`. If `refreshProfile()` is
later invoked it goes through `loadProfile()` which in Tier 0 reads
`dbClient.me.get` again and calls `setProfile(...)` independently.
This is functionally fine but means the same payload-shaping logic is
duplicated. Consider extracting `meToProfile(me)` and calling it from
both sites.

#### LN-04 — `auth.users` insert uses `gen_random_uuid()` not the auth-system path

*File:* `backend/src/auth.ts:42-48`

The Tier-0 overlay `CREATE TABLE auth.users (...)` is a stub — there's
no real GoTrue / Supabase auth running. `signupOrSwitch` inserts directly
with a fresh UUID. The `handle_new_user` trigger in
`supabase/migrations/00000000000000_initial_schema.sql:1838-1840` fires
`AFTER INSERT ON auth.users` and inserts into `plannen.users` — but
`signupOrSwitch` *also* does its own `INSERT INTO plannen.users ... ON
CONFLICT (id) DO UPDATE`, so the trigger's insert is no-op on conflict
and harmless. Worth confirming the trigger is present in Tier 0 — if not,
the explicit `INSERT INTO plannen.users` is doing the real work.

Action: drop a comment in `auth.ts` noting that the explicit
`plannen.users` insert is the load-bearing one in Tier 0 and the trigger
is a Tier-1 fallback.

#### LN-05 — `rewriteEnvKey` regex sanitization is over-aggressive

*File:* `backend/src/_shared-overlay/rewriteEnv.ts:8`

```ts
const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=`)
```

The character class escapes more than needed (e.g. `{`, `}`, `|`) and
includes `\\\\` which is a double-escaped backslash — not wrong for any
realistic env-var name but stylistically noisy. The unit tests cover
the realistic cases. Low-priority cleanup.

#### LN-06 — Backend started by hand loses the identity-persist path

*File:* `scripts/backend-start.sh:18`, `backend/src/routes/api/me.ts:55-62`

If someone runs `node backend/dist/index.js` directly (without going
through `backend-start.sh`), `PLANNEN_ENV_PATH` is unset and the
"persist identity to `.env`" step is silently skipped. The in-memory
switch still works for the current process but a backend restart will
revert to whatever `PLANNEN_USER_EMAIL` was at original startup.

Acceptable because the script is the documented entry point. Worth a
console.warn at boot if `PLANNEN_TIER==='0'` and `PLANNEN_ENV_PATH` is
unset.

#### LM-01 — Modal has no focus trap (carry-over)

Unchanged.

#### LM-02 — Dashboard `?view=` vs `/profile` split (carry-over)

Unchanged.

#### LM-03 — No catch-all route (carry-over)

Unchanged.

#### LM-04 — `/` route reads `window.location` at render time (carry-over)

Unchanged.

#### LM-05 — Settings header doesn't restate "web-UI-only" scope (carry-over)

Unchanged.

#### LM-06 — `SettingsContext.useEffect` not StrictMode-guarded (carry-over)

Unchanged. The new `dbClient.me.signup` is *not* affected — it's only
called from the form-submit handler in `Login.tsx`, never from an
effect.

#### LM-07 — `Privacy` "Back" link routes through redirect chain (carry-over)

Unchanged.

#### LM-08 — `TIER` constant duplicated across 12 files (carry-over)

Unchanged. `grep -rn "import.meta.env.VITE_PLANNEN_TIER" src/` returns
12 files.

#### LM-09 — `Navigation` missing active state for `/profile` / `/privacy` (carry-over)

Unchanged.

## Open questions

1. **Threat model for `POST /api/me`** — Should the route gate on a
   shared secret loaded from `.env`? For Tier 0 the loopback bind is
   probably enough, but worth a deliberate note in
   `docs/TIERED_DEPLOYMENT_MODEL.md`.

2. **Should `/login` be the identity-switch surface?** The form is
   labelled "Sign in with Email" but in Tier 0 the actual semantics are
   "switch identity". A dedicated `/switch-identity` route or a settings
   panel would be clearer. The current overload was the minimum
   viable fix.

3. **Should signed-out state exist at all in Tier 0?** Currently
   `signOut` is a no-op so the user is never *actually* signed out. The
   visual sign-out icon implies otherwise.

4. **Identity history** — Does the user need to see / pick from existing
   `plannen.users` rows? The current flow only allows "type an email and
   the backend will resolve or create".

5. **Should the `.env` rewrite be opt-in?** Persisting `PLANNEN_USER_EMAIL`
   means a backend crash + restart sees the new identity. Some users
   might prefer a session-scoped switch that reverts on restart. Today
   there's no toggle.

6. **Are the prior audit's Tier-2 questions still relevant?** (Tier 2 is
   only acknowledged in `BackendBadge`.) `signup` in Tier 1 explicitly
   throws — what should it do in Tier 2? Likely the same throw, but the
   `dbClient` type should reflect "tier 0 only" more loudly.

7. **Carry-over from prior audit:** (a) catch-all route, (b) Modal focus
   trap, (c) `TIER` constant module, (d) Settings header copy, (e)
   `SettingsContext` StrictMode guard, (f) Privacy back-link, (g)
   `appAccessService.inviteEmailToApp` no-op. None of these were touched
   by `a1a9f90` — they're all on the existing backlog.
