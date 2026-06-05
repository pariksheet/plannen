# Audit 03 — Profile

Static, evidence-based audit of the Plannen Profile UI. All findings derive from reading source in `/Users/stroomnova/Music/plannen/.worktrees/plannen-ui` — no runtime probing.

## Summary

The Profile page (`src/pages/Profile.tsx`) wires four section components — Personal Info, Locations, Interests & Goals, Family Members — onto a thin service layer (`src/services/profileService.ts`) that delegates to a tier-aware `dbClient` (`src/lib/dbClient/{tier0,tier1}.ts`). The save→refetch loop is uniformly implemented: every mutation handler calls the backend, then re-reads the list/profile (no optimistic update). The wiring is mostly sound — every `Save`/`Add`/`Update`/`Delete` button reaches a working backend call in both tiers — but the audit found:

- One **BROKEN** flow: `AddFamilyMember.tsx` (used by `MyFamily`, in scope per the brief) calls `sendRelationshipRequest`, which is hard-coded to return an error.
- One **RISKY** edge: child components seed local form state from props on first render but never re-sync via `useEffect`, so an external update (e.g. passive profile-fact extraction landing a goal/interest into `user_profiles`) or a server-side normalization will not appear in the editor until the page is reloaded.
- Several **MINOR** issues: zero client-side validation (date of birth, timezone format, location address); the `Locations.address` field is the only large free-text field with no max-length; the family-member `relation` is freeform with no enum (matches the DB) but no autocomplete/hint list; the family-member `goals`/`interests` form does not dedupe.
- **No schema drift was found in the actively edited fields.** Every column the UI writes (`dob`, `goals`, `interests`, `timezone`, `label`, `address`, `city`, `country`, `is_default`, `name`, `relation`, `dob`, `gender`, `goals`, `interests`, `full_name`, `avatar_url`) exists in the corresponding migration table.
- The Profile page **never surfaces `profile_facts`** — the table is silently populated by the plugin's passive-extraction loop (`plannen-core.md`) and read back via MCP `list_profile_facts`. Users have no UI to view or correct facts; the only overlap-conflict surface is the shared `user_profiles.goals` / `user_profiles.interests` arrays (see *Open questions*).
- `ProfilePersonalInfo` exposes `full_name` as a **disabled** input with hint "Change in onboarding" — but onboarding redirects away if `full_name` is set (`src/pages/Onboarding.tsx:19-23`). Net effect: the user has **no UI path** to rename themselves after first run.

## Components reviewed (table)

| Component | Path | Backend calls | Status |
|---|---|---|---|
| `Profile` (page) | `src/pages/Profile.tsx` | `getProfile`, `getLocations`, `getFamilyMembers`, `upsertProfile`, `addLocation`, `updateLocation`, `deleteLocation`, `addFamilyMember`, `updateFamilyMember`, `deleteFamilyMember` | OK |
| `ProfilePersonalInfo` | `src/components/ProfilePersonalInfo.tsx` | via `onSave({ dob, timezone })` → `upsertProfile` | OK with MINOR caveats |
| `ProfileLocations` | `src/components/ProfileLocations.tsx` | via `onAdd / onUpdate / onDelete` → `addLocation / updateLocation / deleteLocation` | OK with MINOR caveats |
| `ProfileInterestsGoals` | `src/components/ProfileInterestsGoals.tsx` | via `onSave({ goals, interests })` → `upsertProfile` | RISKY (stale local state) |
| `ProfileFamilyMembers` | `src/components/ProfileFamilyMembers.tsx` | via `onAdd / onUpdate / onDelete` → `addFamilyMember / updateFamilyMember / deleteFamilyMember` | OK with MINOR caveats |
| `AddFamilyMember` | `src/components/AddFamilyMember.tsx` | `sendRelationshipRequest('family')` | **BROKEN** (always errors) |
| `profileService` | `src/services/profileService.ts` | wraps `dbClient.profile / locations / relationships` | OK |
| `dbClient.tier0` | `src/lib/dbClient/tier0.ts` | REST → `/api/profile`, `/api/locations`, `/api/relationships/family-members` | OK |
| `dbClient.tier1` | `src/lib/dbClient/tier1.ts` | supabase-js → `user_profiles`, `user_locations`, `family_members` | OK |
| Backend route | `backend/src/routes/api/profile.ts` | `plannen.user_profiles` + `plannen.users` (full_name/avatar_url dispatch) | OK |
| Backend route | `backend/src/routes/api/relationships.ts` | `plannen.family_members` | OK |
| Backend route | `backend/src/routes/api/locations.ts` | `plannen.user_locations` | OK |

## Flows reviewed

### Update personal info

**Path:** `ProfilePersonalInfo` → `Profile.handleSaveProfile({ dob, timezone })` (`src/pages/Profile.tsx:45-51`) → `upsertProfile` (`src/services/profileService.ts:47-56`) → `dbClient.profile.update`.

- **Tier 1 path:** `tier1.profile.update` upserts `user_profiles` keyed by `user_id` (`src/lib/dbClient/tier1.ts:144-153`). Hits columns `dob`, `goals`, `interests`, `timezone` — all present in `supabase/migrations/00000000000000_initial_schema.sql:714-723`. ✅
- **Tier 0 path:** `tier0.profile.update` → `PATCH /api/profile` (`src/lib/dbClient/tier0.ts:98`) → `backend/src/routes/api/profile.ts:56-113`, which splits incoming keys into `USERS_COLS` (`full_name`, `avatar_url`) and `PROFILE_COLS` (`dob`, `goals`, `interests`, `timezone`, `story_languages`) and dispatches to the right table. ✅
- **Read-back:** After save, `Profile.tsx:49-50` calls `getProfile()` and replaces `userProfile`. State is refreshed correctly.
- **Validation:** `<input type="date">` in `ProfilePersonalInfo.tsx:56-61` gates date format at the browser level. There is **no JS validation** for the timezone string before it is written; an arbitrary value like `"BST"` would land in the column. The backend `ProfilePatch` zod schema (`backend/src/routes/api/profile.ts:20-28`) only checks it is a string. Tier 1 has no validation at all.
- **Error display:** Errors bubble up to `Profile.tsx:24` `saveError` state and render in the red banner at `src/pages/Profile.tsx:123-127`.

**Note:** The `Full name` input at `src/components/ProfilePersonalInfo.tsx:44-51` is `disabled` with the hint *"Change in onboarding"*, but `src/pages/Onboarding.tsx:19-23` redirects to `/dashboard` whenever `profile.full_name` is set. Net effect: the user has no UI path to rename themselves after first sign-up. The backend supports it (`/api/profile` accepts `full_name`; Tier 1 has `dbClient.profile.update({ full_name })` via the same route — though see [RISKY-2] for the tier-1 caveat).

### Add / edit / remove family member

**Path:**

- Add → `ProfileFamilyMembers.handleSubmit` (`src/components/ProfileFamilyMembers.tsx:70-91`) → `Profile.handleAddFamilyMember` (`src/pages/Profile.tsx:76-82`) → `addFamilyMember` (`src/services/profileService.ts:133-142`) → `dbClient.relationships.createFamilyMember`.
- Update → same, with `editingId` set, routed to `updateFamilyMember`.
- Delete → inline icon button at `src/components/ProfileFamilyMembers.tsx:134` → `Profile.handleDeleteFamilyMember` (`src/pages/Profile.tsx:92-97`) → `deleteFamilyMember`. No confirm prompt.

- **Tier 1 path:** `tier1.relationships.createFamilyMember` inserts into `family_members` with `goals: []`, `interests: []` defaults (`src/lib/dbClient/tier1.ts:195-204`). All written columns (`name`, `relation`, `dob`, `gender`, `goals`, `interests`) exist in `supabase/migrations/00000000000000_initial_schema.sql:563-574`. ✅
- **Tier 0 path:** `POST /api/relationships/family-members` (`backend/src/routes/api/relationships.ts:37-53`). Zod schema requires `name`+`relation`. ✅
- **Read-back:** `Profile.tsx:80-81` re-fetches the list; on delete, an optimistic filter at line 96 skips the round trip. (Mildly inconsistent — add/update refetch, delete doesn't — but acceptable since delete is destructive and confirmed by server `204` either way.)
- **Avatar / photo:** none. The card shows an emoji derived from `gender` (`src/components/ProfileFamilyMembers.tsx:115`): `👦` / `👧` / `🧒`. No upload UI.
- **Relationship enum:** Free-text input (`src/components/ProfileFamilyMembers.tsx:156-161`). The DB column is `"relation" "text" NOT NULL` with **no** CHECK constraint (`supabase/migrations/00000000000000_initial_schema.sql:567`), so any string works. The MCP `add_family_member` description suggests *"son", "daughter", "mother", "father"* (`mcp/src/index.ts:1879`) but the UI offers no autocomplete or chip palette. The placeholder text "son, daughter, mother…" (`src/components/ProfileFamilyMembers.tsx:158`) is the only nudge.
- **Gender:** A `<select>` with options `'' / 'male' / 'female' / 'non-binary'` (`src/components/ProfileFamilyMembers.tsx:175-185`). The empty option is labelled "Prefer not to say" and is stored as `null` (`src/components/ProfileFamilyMembers.tsx:78` — `form.gender || null`). DB column is `"gender" "text"` nullable, no CHECK constraint. ✅
- **Validation:** Required: `name`, `relation` (UI-side check at line 71 and at the disabled-button predicate at line 240). Backend repeats it via zod `z.string().min(1)` (`backend/src/routes/api/relationships.ts:16-17`). DOB is `<input type="date">` with no further validation. Goals/interests are arbitrary strings entered chip-style (Enter to add).
- **Goal/interest dedupe:** Unlike `ProfileInterestsGoals`, the family-member form **does not dedupe** when adding to the chip list (`src/components/ProfileFamilyMembers.tsx:50-54`). Typing `"hockey"` twice will land `["hockey", "hockey"]`.

### Add / remove location

**Path:** `ProfileLocations.handleSubmit` (`src/components/ProfileLocations.tsx:34-47`) → `Profile.handleAddLocation` / `handleUpdateLocation` (`src/pages/Profile.tsx:53-67`) → `addLocation` / `updateLocation` (`src/services/profileService.ts:90-111`) → `dbClient.locations.{create,update,delete}`.

- **Tier 1 path:** `tier1.locations.create` first clears `is_default=false` on every other row (`src/lib/dbClient/tier1.ts:252-258`) when the new row is being set as default, then inserts. Same idempotency on update (line 269-275). All columns exist (`supabase/migrations/00000000000000_initial_schema.sql:681-691`). ✅
- **Tier 0 path:** `POST /api/locations` (`src/lib/dbClient/tier0.ts:127`) → `backend/src/routes/api/locations.ts`.
- **Read-back:** Add/update refetch the list; delete optimistically filters (`Profile.tsx:73`).
- **Geocoding:** None. `address`, `city`, `country` are freeform strings. The card render at `src/components/ProfileLocations.tsx:75` shows `${city}, ${country}` (or `address` as fallback).
- **Validation:** Only `label` is required (UI line 35 and disabled-button predicate line 150). Tier 1 has no zod; Tier 0 backend zod schema at `backend/src/routes/api/locations.ts` (unread but referenced) requires `label` per the dbClient contract.
- **Single-default invariant:** Enforced on the create/update path in Tier 1 (`tier1.ts:252`); needs verification in Tier 0 backend (`backend/src/routes/api/locations.ts`) — see *Open questions*.

### Update interests & goals

**Path:** `ProfileInterestsGoals.handleSave` (`src/components/ProfileInterestsGoals.tsx:49-56`) → `Profile.handleSaveProfile({ goals, interests })` (`src/pages/Profile.tsx:45-51`, called with `(editGoals, editInterests)` in that order — matches the lambda signature at line 145) → `upsertProfile` → `dbClient.profile.update`.

- **Tier 1 / Tier 0 paths:** same as *Update personal info*. Columns `goals text[]` / `interests text[]` in `user_profiles` (`supabase/migrations/00000000000000_initial_schema.sql:717-718`). ✅
- **Read-back:** parent refetches and updates `userProfile`. **But** the child component never re-syncs (see [RISKY-1]).
- **Validation:** Free-form strings, dedupe on add (`src/components/ProfileInterestsGoals.tsx:21`, `:33`). Adding the same goal twice silently no-ops because of the `!editGoals.includes(val)` check at line 33. Removing by index (line 38) means duplicate values from legacy data are removed one-by-one.

### Passive extraction overlap

The plugin skill `plugin/skills/plannen-core.md:52-75` documents that Claude will silently call `upsert_profile_fact` on every turn that mentions a durable claim. Facts live in `plannen.profile_facts` (`supabase/migrations/00000000000000_initial_schema.sql:612-626`) — a separate table from `user_profiles.goals/interests`. The two systems run **side by side**:

- The UI writes only to `user_profiles.goals` and `user_profiles.interests` arrays (overwriting on each save). It never touches `profile_facts`.
- The plugin writes only to `profile_facts`. It does not call `update_profile` with `goals`/`interests` arrays.

This means there is **no direct overwrite collision** for facts. However, both sources will be consumed by Claude via `get_profile_context` (`mcp/src/index.ts:975-1026`), which returns both `goals/interests` (from `user_profiles`) **and** the fact list. A user who removes "hockey" from the `Interests` chip list in the UI will not affect a `profile_facts` row with `predicate=likes, value=hockey` — see [RISKY-3].

## Issues found

### [BROKEN-1] `AddFamilyMember` always surfaces an error

`src/components/AddFamilyMember.tsx:22` calls `sendRelationshipRequest(trimmed, 'family')`, and `src/services/relationshipService.ts:54-59` returns:

```ts
export async function sendRelationshipRequest(
  _email: string,
  _relationshipType: 'friend' | 'family' | 'both'
): Promise<{ data: string | null; error: Error | null }> {
  return { data: null, error: new Error('sendRelationshipRequest is not supported in this backend version') }
}
```

The component is mounted in the `Manage family` modal of `MyFamily.tsx:304`. Every submission shows `"sendRelationshipRequest is not supported in this backend version"`. The accompanying `acceptRelationshipRequest` / `declineRelationshipRequest` stubs (lines 66-72) confirm the whole accept/decline flow is also a placeholder.

**Severity:** BROKEN. The button is wired and visible to the user; the error message leaks implementation detail. Either hide the form when the backend doesn't support it, or implement a Tier-1 RPC and proxy in Tier 0. (This is outside the Profile page proper, but the brief lists `AddFamilyMember.tsx` explicitly.)

### [RISKY-1] Child form state does not re-sync when parent props change

`ProfileInterestsGoals` seeds local state from props on the **first** render only:

```ts
// src/components/ProfileInterestsGoals.tsx:13-14
const [editInterests, setEditInterests] = useState<string[]>(interests)
const [editGoals, setEditGoals] = useState<string[]>(goals)
```

There is no `useEffect(() => { setEditInterests(interests) }, [interests])`. After `handleSaveProfile` succeeds, `Profile.tsx:50` updates `userProfile`, which sends fresh `goals`/`interests` props down — but the component keeps its stale local copy. In practice the local copy is usually correct (it was the source for the save), but two sequences fail:

1. The agent calls `update_profile` via MCP during the user's session (e.g. Claude updates goals from a chat) → parent state refreshes → editor stays stale until page reload.
2. The server normalises (e.g. trims, lowercases, dedupes server-side in a future migration) and the saved value differs from the input.

Same pattern in `ProfilePersonalInfo` (`src/components/ProfilePersonalInfo.tsx:14-15`) for `dob` / `timezone`, and `ProfileLocations` / `ProfileFamilyMembers` for their `form` state (which is reset by `startAdd` / `startEdit` calls).

**Severity:** RISKY. The fix is a one-line `useEffect` keyed on the relevant prop, or a `key={…}` re-mount on the parent — but care needs to be taken to not stomp on in-progress edits.

### [RISKY-2] Tier-1 path will fail if `dbClient.profile.update` is passed `full_name` / `avatar_url`

`src/lib/dbClient/tier1.ts:144-153`:

```ts
profile: {
  update: async (patch) => {
    const uid = await currentUserId()
    const { data, error } = await supabase
      .from('user_profiles')
      .upsert({ user_id: uid, ...patch }, { onConflict: 'user_id' })
      ...
```

This upserts into `user_profiles`, whose columns are only `user_id, dob, goals, interests, timezone, story_languages` (`supabase/migrations/00000000000000_initial_schema.sql:714-723`). Passing `full_name` or `avatar_url` would error with a Postgres "column does not exist".

The Profile page does not exercise this — it only sends `{ dob, timezone, goals, interests }` (`src/pages/Profile.tsx:45,134,145`). **But `src/pages/Onboarding.tsx:37` does** — `await dbClient.profile.update({ full_name: trimmedName, avatar_url: sticker })` is the Tier-0-only branch, gated behind `TIER === '0'`. In Tier 1, Onboarding falls back to a direct `supabase.from('users').update(...)` (line 39-47). So the Tier-1 contract drift is currently un-triggered, but the `DbClient` interface (`src/lib/dbClient/types.ts:202-208`) ostensibly accepts `Partial<ProfileRow>`, and `ProfileRow` does not include `full_name`/`avatar_url` either — so technically the call site in Onboarding is already type-unsafe (it passes keys that aren't in the row type). The compiler likely lets it through because the type is `Partial<ProfileRow>` widened by structural matching.

**Severity:** RISKY (latent). If any future caller invokes `dbClient.profile.update` with `full_name`/`avatar_url` outside the Tier-0 guard, Tier 1 will throw at runtime. Either:

- Make the Tier-1 implementation also dispatch to `plannen.users` for those fields (mirror the backend route), or
- Tighten `ProfileRow` and the `update` signature so those keys are rejected at compile time outside Tier 0.

### [RISKY-3] No UI to view/correct `profile_facts`

The plugin silently writes durable facts to `plannen.profile_facts` via `upsert_profile_fact` (`plugin/skills/plannen-core.md:52-70`). The MCP server exposes `list_profile_facts` / `correct_profile_fact` (`mcp/src/index.ts:2007-2039`) — and the backend route at `backend/src/routes/api/profile.ts:117-191` is fully implemented (GET `/api/profile/facts`, POST, PATCH, DELETE) — but the web app **never calls any of them**:

```
$ grep -rn "listFacts\|upsertFact\|deleteFact" src/
src/lib/dbClient/types.ts:205-207     # interface definitions
src/lib/dbClient/tier0.ts:99-102      # implementations
src/lib/dbClient/tier1.ts:154-180     # implementations
```

(zero call sites in `src/components/` or `src/pages/`).

**Severity:** RISKY. The user has no way to see what Claude inferred about them, contradict a stale fact, or wipe a leaked datum. The plugin doc says *"If the user asks 'what do you know about me?' or similar, call `list_profile_facts`"* (`plannen-core.md:75`) — i.e. the read-back is gated on a conversational prompt rather than discoverable from the UI. For a privacy-positive app this is the largest functional gap on the Profile page.

### [RISKY-4] Full-name editing is unreachable post-onboarding

`src/components/ProfilePersonalInfo.tsx:44-51` renders `Full name` as a disabled text input with hint *"Change in onboarding"*, but `src/pages/Onboarding.tsx:19-23`:

```ts
useEffect(() => {
  if (profile?.full_name) {
    navigate('/dashboard', { replace: true })
  }
}, [profile, navigate])
```

immediately redirects users with a set name away from `/onboarding`. There is no other UI surface that writes `users.full_name`. A user who types their name wrong on first run cannot fix it without DB access (or asking Claude to call `update_profile` with `full_name`, which the MCP `update_profile` does not accept — `mcp/src/index.ts:1843-1855` — so even that path fails). Avatar sticker has the same issue.

**Severity:** RISKY. Either enable the input + hook it to `dbClient.profile.update({ full_name })` (Tier 0) / `supabase.from('users').update(...)` (Tier 1), or remove the redirect guard from Onboarding and treat that page as the canonical name editor.

### [MINOR-1] No client-side validation for timezone strings

`ProfilePersonalInfo.tsx:67-73` is a plain `<input type="text">` with placeholder "e.g. Europe/Brussels, Australia/Sydney". `handleSave` only trims and falls back to `'UTC'` if empty (line 21). The server zod is `z.string()` (`backend/src/routes/api/profile.ts:26`). Garbage like `"BST"` would store happily. Given the hint *"Claude can set this automatically"*, the input arguably should be a typeahead against a canonical IANA list, or at least call `Intl.supportedValuesOf('timeZone').includes(value)` before save.

### [MINOR-2] No `dob` sanity check (UI-side)

Both `ProfilePersonalInfo.tsx:56-61` and `ProfileFamilyMembers.tsx:166-171` accept any `<input type="date">` value. The `computeAge` helper (`src/components/ProfileFamilyMembers.tsx:15-23`) will happily return e.g. `-30` for a future DOB. The age badge in the card render (`:121`) prints `… · -30 yrs`. Bound `max={today}` on the date input would close this.

### [MINOR-3] No `confirm()` on delete

`Profile.tsx:69-74` (locations) and `:92-97` (family members) call delete with no confirmation. The icon buttons (`ProfileLocations.tsx:80-82`, `ProfileFamilyMembers.tsx:134-136`) are flush against the edit icon — accidental clicks will silently destroy a record. A `confirm('Remove <name>?')` or a tiny modal is the minimum bar.

### [MINOR-4] Family-member form does not dedupe goals/interests

`src/components/ProfileFamilyMembers.tsx:50-54`:

```ts
function addGoalToForm() {
  const val = goalInput.trim()
  if (val) setForm((f) => ({ ...f, goals: [...f.goals, val] }))
  setGoalInput('')
}
```

No `!f.goals.includes(val)` guard. `ProfileInterestsGoals.tsx:31-34` does have the guard. Inconsistency causes duplicate chips in family-member records.

### [MINOR-5] Initial load surfaces only the first error

`src/pages/Profile.tsx:30-32`:

```ts
if (p.error || l.error || f.error) {
  setSaveError((p.error ?? l.error ?? f.error)!.message)
}
setUserProfile(p.data)
setLocations(l.data)
setFamilyMembers(f.data)
```

If `getProfile` succeeds but `getLocations` fails, the error message shown is the locations message, but the page still renders an empty locations list (because `l.data` is `[]` from the catch in `profileService.ts:86`). The user has no indication which section is broken. Showing the error inline per section, or labelling the banner with the source, would help.

### [MINOR-6] `ProfileLocations` shows `address` only when `city` and `country` are both empty

`src/components/ProfileLocations.tsx:75`:

```tsx
<p className="text-xs text-gray-500 truncate">{[loc.city, loc.country].filter(Boolean).join(', ') || loc.address}</p>
```

A location with `city="Mechelen"`, `country=""`, `address="Wollemarkt 36"` will render just `"Mechelen"`. The full address is hidden until the user clicks edit. Likely intentional, but worth flagging.

### [MINOR-7] `AddFamilyMember` email field has no validation

`src/components/AddFamilyMember.tsx:36-41` uses `type="email"` but the browser-side check only runs if the input is inside a form with native validation — which it is, but the submit handler `handleSubmit` at `:15-30` calls `e.preventDefault()` before checking validity and only trims. Submitting `"foo"` returns the unsupported-backend error rather than a "valid email please" hint. Moot until BROKEN-1 is fixed, but worth noting.

### [MINOR-8] No `relation` enum or autocomplete

The MCP doc-string and the placeholder both nudge towards `son / daughter / mother / father`, but the DB column is `text` with no CHECK and the UI is `<input type="text">`. Inconsistent capitalisation (`Son` vs `son`) will create silently divergent rows. A datalist or dropdown with a free-text "Other…" option would normalise this.

### [MINOR-9] `ProfileInterestsGoals` accepts `,` as a separator for interests but not goals

`src/components/ProfileInterestsGoals.tsx:42`:

```ts
if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInterest() }
```

vs `:46`:

```ts
if (e.key === 'Enter') { e.preventDefault(); addGoal() }
```

Likely intentional (goals are sentence-shaped, interests are tag-shaped) but undocumented and inconsistent.

## Component walkthroughs

### `Profile` page (`src/pages/Profile.tsx`)

State (lines 20-24):

```ts
const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
const [locations, setLocations] = useState<UserLocation[]>([])
const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([])
const [loading, setLoading] = useState(true)
const [saveError, setSaveError] = useState<string | null>(null)
```

Mount effect (lines 26-43):

- Parallel fetches via `Promise.all`. Failure mode: if any one `{ error }` is set, the banner shows the first non-null message; the page **still** sets state from `p.data / l.data / f.data` (each defaults to `null` / `[]` in `profileService`, so the render survives). See [MINOR-5].
- No retry; no refresh button. To recover from a transient backend hiccup, the user must reload.

Mutation handlers (lines 45-97):

- All eight handlers share the shape "clear saveError → call backend → if error, set saveError and bail → else refetch the affected resource and set state".
- The delete handlers (`handleDeleteLocation`, `handleDeleteFamilyMember`) **do not refetch** — they optimistically filter the local array. This works fine for the happy path; if a hidden cascade (e.g. server-side cleanup of `profile_facts` tied to the deleted family member) is added later, the user won't see it without a reload.

Render (lines 107-156):

- Single column layout, `max-w-2xl`. Each section is a self-contained card with its own collapse state.
- The `saveError` banner is at the top of the four cards; clicking through subsequent operations does not auto-dismiss the banner — only the next handler call clears it via `setSaveError(null)` (line 46 etc.). A persistent stale error after a successful retry is possible only if the user never triggers another action.
- `authProfile?.avatar_sticker` is displayed in the header (line 118-119). If the user has never set one, the header shows nothing — there is no fallback emoji here (unlike `Navigation.tsx:76` which falls back to `🙂`).

### `ProfilePersonalInfo` (`src/components/ProfilePersonalInfo.tsx`)

State (lines 13-16):

```ts
const [open, setOpen] = useState(true)
const [editDob, setEditDob] = useState(dob ?? '')
const [editTz, setEditTz] = useState(timezone)
const [saving, setSaving] = useState(false)
```

- Initial seeding from props happens once. No `useEffect` to re-seed when parent passes fresh `dob` / `timezone` — see [RISKY-1].
- `handleSave` (lines 18-25) calls `onSave(editDob || null, editTz.trim() || 'UTC')`. The `|| null` collapses both the empty string and falsy `'0'` (irrelevant for date inputs) — fine for date. The `|| 'UTC'` collapses a whitespace-only timezone to `'UTC'`, silently — which is friendlier than erroring but masks intent.

Edge cases:

- **`<input type="date">` localisation.** The `value` is `YYYY-MM-DD`. Most browsers render their locale label, but the value is ISO. The MCP `update_profile` description (`mcp/src/index.ts:1848`) also expects `YYYY-MM-DD`. Aligned. ✅
- **Cancel button.** None. The user has no way to discard edits before saving — closing the section by toggling `open` keeps local state. Re-opening shows the dirty state. The only "reset" is to reload the page.

### `ProfileLocations` (`src/components/ProfileLocations.tsx`)

State (lines 16-20):

```ts
const [open, setOpen] = useState(true)
const [showForm, setShowForm] = useState(false)
const [editingId, setEditingId] = useState<string | null>(null)
const [form, setForm] = useState(EMPTY_FORM)
const [saving, setSaving] = useState(false)
```

Lifecycle:

- `startAdd()` and `startEdit(loc)` seed the form. Closing via `Cancel` (line 142) resets explicitly. Closing via successful save (line 43 `setShowForm(false)`) does **not** reset the form — but the next `startAdd`/`startEdit` will reset.
- After a successful save, `editingId` is **not** cleared (line 41-43 only flips `showForm` to false). If the user immediately clicks `+ Add location`, `startAdd` resets `editingId` to null (line 23), so it's harmless — but a defensive `setEditingId(null)` after save would be tidier.

Render:

- The default-vs-non-default visual treatment (lines 65-74) uses green border + green pill. The MapPin icon also gets the green tint. Clear.
- The card subtitle prefers `${city}, ${country}` over `address` — see [MINOR-6].
- The form does not auto-focus the first input on `startAdd` / `startEdit`. Minor UX nit.

### `ProfileInterestsGoals` (`src/components/ProfileInterestsGoals.tsx`)

State (lines 12-17):

```ts
const [open, setOpen] = useState(true)
const [editInterests, setEditInterests] = useState<string[]>(interests)
const [editGoals, setEditGoals] = useState<string[]>(goals)
const [interestInput, setInterestInput] = useState('')
const [goalInput, setGoalInput] = useState('')
const [saving, setSaving] = useState(false)
```

- Same first-render-only prop seeding as `ProfilePersonalInfo` — see [RISKY-1].
- `addInterest` dedupes on value (line 21); `addGoal` dedupes on value (line 33).
- `removeInterest(tag)` filters by value (line 28) — works only because `addInterest` dedupes. If legacy data has duplicates, `removeInterest('hockey')` will remove all copies.
- `removeGoal(idx)` filters by index (line 38) — removes exactly one. Works with duplicates if any existed.
- `handleInterestKey` treats `,` as an Enter (line 42); `handleGoalKey` does not (line 46). See [MINOR-9].

Render:

- Interests use violet pill chips (`bg-violet-100 text-violet-700`); goals use grey rows with full-width cards. The visual contrast signals "tag" vs "sentence" — good.
- No length cap on either input. Pasting 5 KB of text would silently land in the array.

### `ProfileFamilyMembers` (`src/components/ProfileFamilyMembers.tsx`)

State (lines 26-32):

```ts
const [open, setOpen] = useState(true)
const [showForm, setShowForm] = useState(false)
const [editingId, setEditingId] = useState<string | null>(null)
const [form, setForm] = useState(EMPTY_FORM)
const [goalInput, setGoalInput] = useState('')
const [interestInput, setInterestInput] = useState('')
const [saving, setSaving] = useState(false)
```

Lifecycle:

- `startAdd` (line 34-40) and `startEdit` (line 42-48) both reset all three input buffers. Good.
- `handleSubmit` (line 70-91) trims `name` and `relation`, falls back to `null` for `dob` and `gender`, passes `goals`/`interests` as-is. The trim is **on the field value only** — the chip array members are not trimmed before save (because they were trimmed at chip-creation time on lines 51 and 61).
- After save (line 87), `showForm` flips off but `form` / `editingId` are not reset. The next `startAdd`/`startEdit` resets them.

Render:

- Empty interests/goals arrays do not render their labels (lines 124, 127) — clean.
- Age computation runs every render via `computeAge(m.dob)` (line 111). Trivial cost.
- The gender → emoji mapping (line 115) is `male→👦 / female→👧 / else→🧒` — note this is **child-flavoured**. An adult family member (parent, grandparent) will still get a kid emoji. Probably fine for the family-focused use case but worth a design pass.

### `AddFamilyMember` (`src/components/AddFamilyMember.tsx`)

State (lines 10-13):

```ts
const [email, setEmail] = useState('')
const [loading, setLoading] = useState(false)
const [error, setError] = useState('')
const [message, setMessage] = useState('')
```

- Submit path is broken (see [BROKEN-1]).
- On the (unreachable) success path, the success message *"Request sent. They'll see it once they're in My Family (or when they accept)."* implies a relationship-request flow that the v0 REST surface does not support. The string is a fossil from the Tier-1 RPC era.

## Schema drift cross-check

For each writable field, the UI source line is paired with the migration line that defines the column. Every field the UI tries to persist landed in a real column — no drift was found for the actively-saved fields. Drift in the *unused* surface (`dbClient.profile.update` accepting keys with no `user_profiles` column) is captured in [RISKY-2].

### `user_profiles` (UI ↔ `supabase/migrations/00000000000000_initial_schema.sql:714-723`)

| UI field | UI source | Migration line | Type match |
|---|---|---|---|
| `user_id` | implicit via `auth.uid()` server-side | `"user_id" "uuid" NOT NULL` (L715) | ✅ |
| `dob` | `ProfilePersonalInfo.tsx:14` `useState(dob ?? '')` → `ProfilePersonalInfo.tsx:21` `editDob || null` | `"dob" "date"` (L716) | ✅ `null` clears |
| `goals` | `ProfileInterestsGoals.tsx:14` `useState<string[]>(goals)` | `"goals" "text"[] ... NOT NULL` (L717) | ✅ |
| `interests` | `ProfileInterestsGoals.tsx:13` `useState<string[]>(interests)` | `"interests" "text"[] ... NOT NULL` (L718) | ✅ |
| `timezone` | `ProfilePersonalInfo.tsx:15` `useState(timezone)` → `:21` `editTz.trim() || 'UTC'` | `"timezone" "text" DEFAULT 'UTC' NOT NULL` (L719) | ✅ |
| `story_languages` | not edited from the profile page; written via `setStoryLanguages` in `profileService.ts:68` | `"story_languages" "text"[] DEFAULT '{en}'` with `CHECK (array_length(...) <= 3 AND >= 1)` (L720-722) | ✅ — `validateStoryLanguages` in `utils/storyLanguages` enforces the same constraint client-side |

Profile page sends only `{ dob, timezone }` (`Profile.tsx:134`) or `{ goals, interests }` (`Profile.tsx:145`). The `handleSaveProfile` signature (`Profile.tsx:45`) only types those four keys — nothing else will compile through, so the page cannot trigger [RISKY-2] on its own.

### `users` (Onboarding ↔ `supabase/migrations/00000000000000_initial_schema.sql:751-759`)

| UI field | UI source | Migration line | Notes |
|---|---|---|---|
| `full_name` | `Onboarding.tsx:37` (Tier 0) or `:41` (Tier 1) | `"full_name" "text"` (L754) | Read-back via `AuthContext.loadProfile` `:60` |
| `avatar_url` | same (`avatar_url: sticker`) | `"avatar_url" "text"` (L755) | Mapped to `profile.avatar_sticker` in `AuthContext.tsx:51, :77, :114` |
| `email` | not written from UI | `"email" "text" NOT NULL` (L753) | Seeded at user creation |
| `preferred_language` | not written from UI | `"preferred_language" "text"` (L756) | Unused by the profile page (the language UI sits under `setStoryLanguages` on a different surface) |

The Profile page exposes `full_name` as a read-only echo of `authProfile.full_name` (`ProfilePersonalInfo.tsx:46`). See [RISKY-4].

### `family_members` (UI ↔ `supabase/migrations/00000000000000_initial_schema.sql:563-574`)

| UI field | UI source | Migration line | Notes |
|---|---|---|---|
| `name` | `ProfileFamilyMembers.tsx:150` `setForm({ name })` → `:75` `form.name.trim()` | `"name" "text" NOT NULL` (L566) | Required UI-side and DB-side |
| `relation` | `ProfileFamilyMembers.tsx:160` | `"relation" "text" NOT NULL` (L567) | Free-text, no enum — see [MINOR-8] |
| `dob` | `ProfileFamilyMembers.tsx:169` → `:77` `form.dob \|\| null` | `"dob" "date"` (L568) | ✅ |
| `gender` | `ProfileFamilyMembers.tsx:176` → `:78` `form.gender \|\| null` | `"gender" "text"` (L569) | UI dropdown values: `male / female / non-binary / ''→null`. DB has no CHECK; any value would persist |
| `goals` | `ProfileFamilyMembers.tsx:79` `form.goals` | `"goals" "text"[] ... NOT NULL` (L570) | Defaults to `'{}'` |
| `interests` | `ProfileFamilyMembers.tsx:80` `form.interests` | `"interests" "text"[] ... NOT NULL` (L573) | Defaults to `'{}'` |
| `created_at` | server-side default | `DEFAULT now() NOT NULL` (L571) | — |
| `updated_at` | bumped in `tier1.ts:209` and `relationships.ts:72`/`:108` | `DEFAULT now() NOT NULL` (L572) | ✅ |

### `user_locations` (UI ↔ `supabase/migrations/00000000000000_initial_schema.sql:681-691`)

| UI field | UI source | Migration line | Notes |
|---|---|---|---|
| `label` | `ProfileLocations.tsx:95` → `:35` `form.label.trim()` | `"label" "text" NOT NULL` (L684) | Required |
| `address` | `ProfileLocations.tsx:125` | `"address" "text" DEFAULT '' NOT NULL` (L685) | Freeform |
| `city` | `ProfileLocations.tsx:105` | `"city" "text" DEFAULT '' NOT NULL` (L686) | Freeform — no validation against country |
| `country` | `ProfileLocations.tsx:115` | `"country" "text" DEFAULT '' NOT NULL` (L687) | Freeform — no ISO code coercion |
| `is_default` | `ProfileLocations.tsx:133` | `"is_default" boolean DEFAULT false NOT NULL` (L688) | Single-default enforced in `tier1.ts:252-275` |
| `created_at` / `updated_at` | server-side defaults | L689-690 | — |

### `profile_facts` (not surfaced in UI ↔ `supabase/migrations/00000000000000_initial_schema.sql:612-626`)

For completeness, since the audit's brief asks about the *passive extraction overlap*:

| Column | Migration line | Plugin/MCP usage |
|---|---|---|
| `id` | L613 | Internal |
| `user_id` | L614 | Set via `auth.uid()` server-side in `mcp/src/index.ts:1027-1056` |
| `subject` | L615 | `"user"` or a `family_members.id` UUID per `plannen-core.md:61` |
| `predicate` | L616 | Free-text (`likes`, `goes_to_school_at`, `swimming_class`, …); uniqueness on `(subject, predicate)` per `plannen-core.md:63` |
| `value` | L617 | Free-text |
| `confidence` | L618 | `DOUBLE PRECISION` 0..1, `CHECK` constraint L624 |
| `observed_count` | L619 | Not exposed in MCP tools; populated server-side |
| `source` | L620 | `'agent_inferred' \| 'user_stated'`, `CHECK` constraint L625 |
| `is_historical` | L621 | Flipped by `correct_profile_fact` |
| `first_seen_at` / `last_seen_at` | L622-623 | Server-managed |

No UI reads or writes this table — see [RISKY-3].

## Backend route summary

For traceability, each Tier-0 route the Profile page exercises:

| HTTP path | Source | UI caller |
|---|---|---|
| `GET /api/profile` | `backend/src/routes/api/profile.ts:45-54` | `dbClient.profile.get()` (tier0.ts:97) |
| `PATCH /api/profile` | `backend/src/routes/api/profile.ts:56-113` (dispatches users/user_profiles) | `dbClient.profile.update()` (tier0.ts:98) |
| `GET /api/locations` | `backend/src/routes/api/locations.ts` (not read in this audit) | `dbClient.locations.list()` (tier0.ts:126) |
| `POST /api/locations` | same | `dbClient.locations.create()` (tier0.ts:127) |
| `PATCH /api/locations/:id` | same | `dbClient.locations.update()` (tier0.ts:128-129) |
| `DELETE /api/locations/:id` | same | `dbClient.locations.delete()` (tier0.ts:130) |
| `GET /api/relationships/family-members` | `backend/src/routes/api/relationships.ts:26-35` | `dbClient.relationships.listFamilyMembers()` (tier0.ts:107) |
| `POST /api/relationships/family-members` | `backend/src/routes/api/relationships.ts:37-53` | `dbClient.relationships.createFamilyMember()` (tier0.ts:108-112) |
| `PATCH /api/relationships/family-members/:id` | `backend/src/routes/api/relationships.ts:55-80` | `dbClient.relationships.updateFamilyMember()` (tier0.ts:113-117) |
| `DELETE /api/relationships/family-members/:id` | `backend/src/routes/api/relationships.ts:82-93` | `dbClient.relationships.deleteFamilyMember()` (tier0.ts:118-120) |

Routes the **profile** UI does *not* call but the schema/MCP surface defines:

| HTTP path | UI gap |
|---|---|
| `GET /api/profile/facts` (`backend/.../profile.ts:117-133`) | No UI consumer — [RISKY-3] |
| `POST /api/profile/facts` (`backend/.../profile.ts:135-151`) | No UI consumer — [RISKY-3] |
| `PATCH /api/profile/facts/:id` (`backend/.../profile.ts:153-178`) | No UI consumer |
| `DELETE /api/profile/facts/:id` (`backend/.../profile.ts:180-191`) | No UI consumer |

## Open questions

1. **Should `profile_facts` have a UI surface?** Given the privacy framing ("offline single-user app, no multi-user concerns") in `memory/project_deployment_model.md`, the lack of a visible facts table may be a deliberate "trust Claude" choice. But the user has no way to audit or scrub. Worth a brainstorm: a collapsible "Facts Claude knows" section with delete buttons.
2. **Should `goals`/`interests` on `user_profiles` be folded into `profile_facts`?** The current double-storage means a fact like *likes hiking* could live in both `user_profiles.interests` and `profile_facts (predicate=likes, value=hiking)` — but only the UI value is editable from the web app, and only the fact is created passively. A migration to a single source of truth (facts) with a virtualised UI projection would close the divergence.
3. **Tier-0 backend single-default invariant for `user_locations`.** Did not read `backend/src/routes/api/locations.ts` in this audit — Tier 1 enforces it client-side (`tier1.ts:252`, `:269`). Confirm Tier 0 has the same `UPDATE ... SET is_default=false` step server-side, otherwise a Tier-0 user can have multiple default locations.
4. **Onboarding redirect vs editable name.** Is the *"Change in onboarding"* hint legacy from a previous design where onboarding was reachable from a settings link? If yes, the disabled input should either become editable or the hint should be replaced with *"Contact support to change"*.
5. **Avatar sticker scope.** `users.avatar_url` is presented as an emoji picker (`Onboarding.tsx:9`). The DB column is `text` — no schema enforcement that it be a single grapheme. A future "upload a photo" feature would re-use the same column without a migration; clarify whether the UI should ever allow arbitrary URLs there.
6. **`ProfileFamilyMembers` and the MCP `add_family_member` interest vocabulary.** The MCP tool description says interests are *"hobbies for this family member (e.g. 'hockey', 'swimming')"* (`mcp/src/index.ts:1883`). The UI accepts arbitrary strings, but downstream consumers (e.g. event-discovery tag matching in `plannen-discovery.md`) presumably want lowercase, kebab-case, activity-shaped tags. There's no normalisation step.
7. **Delete cascade for family members.** When a user deletes a family member from the UI, are the linked `profile_facts` (subject = family-member UUID) cascaded? The schema dump (`00000000000000_initial_schema.sql`) needs to be checked for FK constraints — `profile_facts.subject` is `text`, not `uuid`, so there's likely no FK and the facts become orphaned. Worth confirming in a separate audit.
