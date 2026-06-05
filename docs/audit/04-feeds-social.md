# Audit 04 — Feeds & Social

## Summary

The social/feed surface is a hybrid of one live, well-wired view (`MyFeed`) and three half-dead feeds (`MyFamily`, `MyFriends`, `MyGroups`) that descend from a previous multi-user design and are now nailed shut by the Tier-0 service layer.

Headline findings:

1. **MyFeed is healthy.** `getMyFeedEvents` calls `dbClient.events.list({ limit: 500 })` (`src/services/viewService.ts:10`), so the `list_events` truncation gotcha does not apply. Sort, "now" divider, and "Earlier" past-loader all behave as intended.
2. **MyFamily / MyFriends / MyGroups event feeds are permanently empty.** Their service helpers (`getFamilyEvents`, `getFriendsEvents`, `getGroupsEvents` in `src/services/viewService.ts:52-65`) are literal stubs that `return { data: [], error: null }`. Every Loading/empty-state/Timeline branch downstream of them is unreachable except the top-level "no family events yet" empty state.
3. **`AddFriend`, `AddFamilyMember`, `PendingRequests`, and most of `ManageGroups` have no backend.** The relationship-service mutate paths (`sendRelationshipRequest`, `acceptRelationshipRequest`, `declineRelationshipRequest`) hard-fail with `new Error('… is not supported in this backend version')` (`src/services/relationshipService.ts:54-72`). `getRelationshipRequests` hard-returns `[]` (`src/services/relationshipService.ts:62-64`). `updateGroup`, `deleteGroup`, `getGroupMembers`, `addGroupMember`, `removeGroupMember`, `getEventSharedWithGroupIds`, `setEventSharedWithGroups` all stub out (`src/services/groupService.ts:39-74`).
4. **Family/Friend lists show raw UUIDs.** `getMyFamily` / `getMyFriends` return `{ id, email: null, full_name: null }` (`src/services/relationshipService.ts:43,50`) because v0 REST has no users-by-id endpoint. The "Family members" / "Friends" lists in the Manage modals fall through to `f.full_name || f.email || f.id` (`MyFamily.tsx:314`, `MyFriends.tsx:314`) and render bare UUIDs.
5. **`MyGroups` violates the past-events-bottom-up convention** ([[feedback_past_events_sort]]). It doesn't sort past at all, slices from the front, and renders past *above* future rather than splicing past below the timeline with a "now" divider — unlike MyFeed/MyFamily/MyFriends which do it correctly.
6. The whole **family/friends/groups dashboard surface is solo-mode cruft.** Per [[project_deployment_model]] Plannen is single-user local-only; there is no other user to befriend, share with, or accept requests from. These tabs are still in `Navigation.tsx` and `Dashboard.tsx:94-96` and offer dead controls.

The single working component outside MyFeed is the *group-creation* form in `ManageGroups.tsx` (it calls `dbClient.groups.create`, which is real) — but creating a group has no observable effect anywhere else because group membership and group-sharing are stubbed.

## Components reviewed (table)

| Component | File | Status | Backend wired? | Renders in solo mode? |
|---|---|---|---|---|
| `MyFeed` | `src/components/MyFeed.tsx` | Working | Yes (`getMyFeedEvents` → `dbClient.events.list({limit:500})`) | Yes — populated |
| `MyFamily` | `src/components/MyFamily.tsx` | Mostly dead | No — `getFamilyEvents` returns `[]`; `getMyFamily` is empty in solo mode | Empty state only |
| `MyFriends` | `src/components/MyFriends.tsx` | Mostly dead | Same — `getFriendsEvents` returns `[]` | Empty state only |
| `MyGroups` | `src/components/MyGroups.tsx` | Mostly dead | Group creation works; events feed `getGroupsEvents` returns `[]` | Empty state only |
| `ManageGroups` | `src/components/ManageGroups.tsx` | Partial | `getMyGroups`/`createGroup` work; rename/delete/members all stubbed | Buttons render, silently no-op |
| `AddFriend` | `src/components/AddFriend.tsx` | Dead | No — `sendRelationshipRequest` throws | Form submits show backend-not-supported error |
| `AddFamilyMember` | `src/components/AddFamilyMember.tsx` | Dead | No — same throw | Same |
| `PendingRequests` | `src/components/PendingRequests.tsx` | Dead | No — `getRelationshipRequests` returns `[]` | Always shows "No pending requests" |
| `Timeline` | `src/components/Timeline.tsx` | Working (shared) | n/a (pure render) | Yes — used by all four feeds + future view |

Cross-references:
- All four feed pages mount `Timeline` and pass `TimelineItem[]` from `buildFutureTimeline` in `src/utils/timeline.ts`.
- `Timeline` renders `EventCard` for every item and inserts a `now` divider between past-today and future items.
- `Dashboard.tsx:92-97` routes the `view` query-param to one of the four components.

## Flows reviewed

### MyFeed render

`MyFeed.tsx:55-70` runs `loadEvents` once on mount.

1. `getMyFeedEvents()` → `dbClient.events.list({ limit: 500 })` (correct; immune to [[feedback_list_events_limit]]).
2. `resolveEventStatus` plus `enrichWithRecurrenceContext` is applied (`src/services/viewService.ts:8-50`) so recurring parents get `sessions_summary` and child sessions inherit `parent_title`.
3. `getPreferredVisitDates` then fans out 1 RSVP fetch per event ID (`src/services/rsvpService.ts:13-25`). For 500 events that's 500 HTTP requests in flight on every reload — see [RISKY: N+1 RSVP fetch](#risky-n1-rsvp-fetch-on-every-feed-load) below.
4. Filtering: kind (event/reminder), hashtag, status pills, "reminder-only suppresses status filter" rule (`MyFeed.tsx:115-118`). Status pills disable visually when reminder-only is active (`MyFeed.tsx:223`).
5. `buildFutureTimeline` (`src/utils/timeline.ts:42-75`) produces the upcoming list with `watching`/`missed` rolled to `+1 year`, multi-day pinned to today, and "immediate next" flagged.
6. Past:
   - `past = filtered.filter(e => event_status === 'past').sort(asc by start_date)` — bottom-up correct (`MyFeed.tsx:120-123`).
   - `slice(-pastVisibleCount)` — most-recent-at-bottom, also correct.
   - Combined `[...visiblePast, ...futureTimeline]` (`MyFeed.tsx:130-132`) so past renders above future; `Timeline.tsx:71-83` inserts a "now" divider between them.
   - "Earlier" button increments `pastVisibleCount` by 5 or first opens the past section (`MyFeed.tsx:299-310`).
7. Loading: `<p>Loading events…</p>` text (no spinner).
8. Empty: centered card with "No events yet. Create your first event…" + a primary Create CTA (`MyFeed.tsx:257-268`).
9. Error: red banner with `feedError` message (`MyFeed.tsx:249-253`).

The Calendar view (`viewMode === 'calendar'`) hands events to `CalendarGrid` (`MyFeed.tsx:287-293`). Verified `CalendarGrid` consumes `events` + `preferredVisitDates` and groups by day.

### MyFamily list & add

`MyFamily.tsx:55-74` runs **two** parallel fetches on mount:

- `getFamilyEvents()` — returns `{ data: [], error: null }` from `viewService.ts:52-55`. Always empty.
- `getMyFamily()` — returns family relationship users; in v0 REST the rows are real but `email`/`full_name` are always `null`. In Tier-0 solo mode the underlying `plannen.relationships` table only contains rows after a request flow that no backend exists for, so this also returns `[]` in practice.

Then `loadPendingCount()` calls `getRelationshipRequests()` → `[]`, so `pendingFamilyCount` is always 0 and the badge on the "Manage family" button never appears.

Render branches (`MyFamily.tsx:212-279`):

- `loading` → "Loading…"
- `events.length === 0` → "No family events yet. Add family members via Manage family…". **This is the only branch ever observed.**
- `filteredEvents.length === 0` → unreachable (events is always [], short-circuits earlier)
- `Timeline` mount → unreachable

Manage modal (`MyFamily.tsx:299-324`):
- "Add family member" form → `AddFamilyMember` → `sendRelationshipRequest(email,'family')` → service throws `'sendRelationshipRequest is not supported in this backend version'` → red error under the form.
- "Family members" list → empty (`<p>No family members yet…</p>`), or if somehow populated, raw UUIDs (`{f.full_name || f.email || f.id}` resolves to `f.id`).
- "Pending requests" via `PendingRequests` with `filter="family"` → always "No pending requests."

The Manage button is the **only** real action the user can take, and every leaf inside the modal is dead or shows UUIDs.

Note: this view is **distinct from** `ProfileFamilyMembers.tsx` (Settings), which writes to the *real* `plannen.family_members` profile table (name/relation/dob/gender/goals/interests). The two share the word "family" but model completely different concepts. There is no link between them.

### MyFriends list & add

Identical structure to MyFamily but routed through `getFriendsEvents` + `getMyFriends` + `filter='friend'`. Same outcome: empty events feed forever, badge never lights, AddFriend always errors, raw-UUID list. (`MyFriends.tsx:55-74`, `MyFriends.tsx:215`, `MyFriends.tsx:308-318`)

### MyGroups & ManageGroups

`MyGroups.tsx:56-72` runs `getGroupsEvents()` → `{ data: [], error: null }`. Top-level empty branch (`MyGroups.tsx:233`) is the only state seen by the user.

`loadEventGroupsContext` (`MyGroups.tsx:78-126`) short-circuits in Tier-0 (`TIER === '0'` returns immediately) and otherwise uses raw `supabase.from('friend_group_members')` and `supabase.from('event_shared_with_groups')` — bypassing `dbClient`. In Tier-0 it just clears the maps. In Tier-1 it would call `friend_group_members.select('group_id')` for the *current* user. This is the only place outside MyGroups that still touches Supabase directly.

Past-events handling differs from the other feeds:

- `past = filteredEvents.filter(e => event_status === 'past')` (`MyGroups.tsx:152`) — **no sort applied**.
- `visiblePast = past.slice(0, pastVisibleCount)` (`MyGroups.tsx:153`) — slice from front (default desc, opposite of `.slice(-N)`).
- Render order (`MyGroups.tsx:268-328`): past **section above** future, separated by a freestanding "Earlier" button. No "now" divider. Past uses `EventList` (flat list) rather than `Timeline` (month-grouped with sticky headers).

This violates [[feedback_past_events_sort]] ("past sorts asc, slice(-N), most-recent-at-bottom, continuous chronological flow into upcoming"). See [BROKEN](#broken-mygroups-past-events-rendering-violates-past-sort-rule).

Manage modal (`MyGroups.tsx:350-357`) mounts `ManageGroups`:

- Create group form → `createGroup(name)` → `dbClient.groups.create(...)` — **works**.
- Group list — `getMyGroups()` → `dbClient.groups.list()` — **works**.
- Member checkboxes inside expanded group — `addGroupMember` / `removeGroupMember` — **stubbed `return { error: null }`** (no-op). The UI shows the checkbox tick because `toggleMember` (`ManageGroups.tsx:96-109`) optimistically mutates local `memberIds` state, but no row is written; on next mount the group is empty again.
- Rename → `updateGroup` throws; the rename input clears (`handleRename` `return` on error at `ManageGroups.tsx:86`) but no state is updated and no error is shown.
- Delete → `deleteGroup` throws; same silent failure.
- Contacts list is built from `getMyFriends()` + `getMyFamily()` — empty in Tier-0, so the modal shows "No friends or family yet. Add them in My Friends or My Family first."

So even though `createGroup` writes a real `plannen.friend_groups` row, you can never add members to it, never rename it, never delete it, and it never affects any feed.

### Pending requests

`PendingRequests.tsx` is mounted twice — once inside the MyFamily Manage modal with `filter='family'`, once inside MyFriends with `filter='friend'`.

`load()` (`PendingRequests.tsx:29-35`) calls `getRelationshipRequests()` which **always** returns `{ data: [], error: null }` (`src/services/relationshipService.ts:62-64`). The component therefore always lands in the `showEmpty` branch ("No pending requests.").

`handleAccept` / `handleDecline` call `acceptRelationshipRequest` / `declineRelationshipRequest`, both of which throw "not supported in this backend version". They're unreachable in practice but would silent-fail (the actions guard `if (!error)` before calling `load()` and `onAcceptOrDecline()`, and there is no UI for the error case — the error is just discarded).

### Timeline (what is it? scope?)

`Timeline.tsx` is the shared month-grouped renderer used by every feed page (`MyFeed`, `MyFamily`, `MyFriends`, `MyGroups`). It is **not** a separate route or view.

Inputs: `TimelineItem[]` (built by `buildFutureTimeline`), event-action callbacks, view flags.

Behaviour:

- Groups items by `YYYY-MM` via `groupTimelineByMonth` (`src/utils/timeline.ts:78-94`), one section per month.
- Each section is collapsible (`collapsedMonths` local Set, header is a button).
- Within a month, items are rendered in `TimelineItem.timelineDate` order (already sorted by `buildFutureTimeline`).
- Inserts a single `now` divider before the first non-past-today item if any past-today items are present (`Timeline.tsx:70-83`).
- Defers all card-level rendering to `EventCard`.

Empty state: centered "No upcoming events" (or caller-supplied `emptyMessage`).

No loading or error state — those live in the parent feed component.

## Issues found

### [BROKEN] MyGroups past-events rendering violates past-sort rule

**File:** `src/components/MyGroups.tsx:151-153, 268-328`

[[feedback_past_events_sort]] says past sorts asc, `slice(-N)`, most-recent-at-bottom, continuous chronological flow into upcoming. MyFeed/MyFamily/MyFriends implement this. MyGroups does not:

- No `.sort` on past (`MyGroups.tsx:152`).
- `slice(0, pastVisibleCount)` instead of `slice(-pastVisibleCount)` (`MyGroups.tsx:153`).
- Past rendered in a separate `EventList` section *above* the future `Timeline` (`MyGroups.tsx:268-328`).
- No "now" divider, no month-grouping for past.

This is unreachable today (groups feed always empty) but the bug exists in source. Recommend porting the MyFeed past-section pattern verbatim.

### [BROKEN] AddFriend / AddFamilyMember have no backend

**Files:** `src/components/AddFriend.tsx`, `src/components/AddFamilyMember.tsx` + `src/services/relationshipService.ts:54-58`

Submit triggers `sendRelationshipRequest` which throws `new Error('sendRelationshipRequest is not supported in this backend version')`. The form shows that text under the input. There is no backend route in `backend/src/routes/api/relationships.ts` for sending a relationship request — only family-members CRUD and a read-only relationships GET.

In a single-user local-only model these forms have no destination user; the surface should either be removed or hidden behind a Tier-1 capability flag.

### [BROKEN] PendingRequests never receives data

**File:** `src/components/PendingRequests.tsx` + `src/services/relationshipService.ts:62-64`

`getRelationshipRequests` is a stub. Accept/decline RPCs likewise throw. The component is reachable only inside Manage modals where it adds visual noise ("No pending requests.") and ~10 lines of layout for state that doesn't exist.

The `pendingFamilyCount` / `pendingFriendsCount` derived state in MyFamily/MyFriends is also dead — always 0 — and the badge UI it gates never renders.

### [BROKEN] ManageGroups member-toggle is optimistic only

**File:** `src/components/ManageGroups.tsx:96-109` + `src/services/groupService.ts:57-64`

Clicking a contact checkbox in an expanded group mutates local `memberIds` state but calls `addGroupMember`/`removeGroupMember` which are no-op stubs returning `{ error: null }`. The user sees a tick; nothing is persisted. On the next mount the group appears empty again. Rename and delete behave the same — service stubs error-out, `handleRename`/`handleDelete` silently swallow the error.

This is a "looks like it worked, didn't" trap. Either wire the routes or disable the controls.

### [RISKY] N+1 RSVP fetch on every feed load

**File:** `src/services/rsvpService.ts:10-25` (`fetchRsvpRows`)

`getPreferredVisitDates` is called after every feed reload (MyFeed `:65-67`, MyFamily `:67-68`, MyFriends `:67-68`, MyGroups `:50-52`). It fans out one `fetch(/api/rsvp?event_id=…)` per event. With `limit: 500` in MyFeed and a busy account, this is 500 sequential-ish HTTP calls per reload — a measurable burst on the local backend and over-network on Tier 1.

The comment in `fetchRsvpRows` explicitly notes the v0 REST exposes single-event GET only. The fix is a multi-id endpoint; until then, this is the dominant per-reload latency.

### [RISKY] Family/Friends/Groups lists render raw UUIDs in Tier 1

**Files:** `src/services/relationshipService.ts:43,50`, `src/components/MyFamily.tsx:314`, `src/components/MyFriends.tsx:314`, `src/components/ManageGroups.tsx:222`

`getMyFriends`/`getMyFamily` return `email: null, full_name: null` because v0 REST has no users-by-id endpoint. The UI falls back to `f.id` (UUID). In Tier-1 supabase mode this still applies (the v0 contract is shared). Group member checkbox labels also fall through to UUIDs.

### [RISKY] MyGroups bypasses `dbClient` and calls `supabase.from` directly

**File:** `src/components/MyGroups.tsx:91-115`

`loadEventGroupsContext` reaches past `dbClient` straight to `supabase.from('friend_group_members')` and `supabase.from('event_shared_with_groups')`. This breaks the dbClient abstraction that the rest of the app uses to swap Tier 0 / Tier 1, and won't work in Tier 0 (the function early-returns when `TIER === '0'`, so it's effectively Tier-1-only code path). A Tier 1 user on Tier-0 backend would silently get empty maps.

If MyGroups is kept, these reads should live behind `dbClient.groups.*` to honor the contract.

### [MINOR] Solo-mode cruft surfaces in Navigation

**Files:** `src/components/Navigation.tsx:39-41`, `src/pages/Dashboard.tsx:94-96`

Per [[project_deployment_model]] Plannen is single-user local-only. The "My Family / My Friends / My Groups" tabs add four routes whose only meaningful interaction is "create a group with no members and no events". They occupy primary nav slots. Recommend hiding them behind a feature flag (e.g. `VITE_PLANNEN_ENABLE_SOCIAL`) defaulting off in Tier 0, until cross-user sharing exists.

### [MINOR] `useAuth()` called for side effect

**Files:** `MyFeed.tsx:32`, `MyFamily.tsx:16`, `MyFriends.tsx:16`, `MyGroups.tsx:19`

`useAuth()` is invoked with no destructure — used to assert the auth context is present (throws if missing). This works but is non-obvious; a `useAuth.assert()` helper or a `// ensure auth context` comment would be clearer.

### [MINOR] MyFamily/MyFriends second `loadEvents` callback unused on mount

**Files:** `MyFamily.tsx:36-49 vs 55-74`, `MyFriends.tsx:36-49 vs 55-74`

The `loadEvents`/`loadFamily` callbacks defined for `refresh()` are duplicated inline inside the mount `useEffect`. The inline copy doesn't go through the memoized callback so it is harder to verify they stay in sync. Not a bug, but a refactor target.

### [MINOR] No loading spinner — just text

**Files:** `MyFeed.tsx:256`, `MyFamily.tsx:213`, `MyFriends.tsx:213`, `MyGroups.tsx:232`

Each feed shows `<p>Loading…</p>` rather than a spinner consistent with the rest of the app (`PendingRequests` and the action buttons all use the `Loader` icon from lucide). Cosmetic only.

### [MINOR] CalendarGrid view doesn't expose `onEdit`

**File:** `src/components/MyFeed.tsx:287-293`

The Calendar branch passes `onDelete` and `onShareSuccess` but no `onEdit`. The Timeline branch passes both. Whether editing is intentionally disabled from the calendar view is unclear; if not, this is a parity gap.

### [MINOR] Past-events `EventList` in MyGroups uses no month grouping

**File:** `src/components/MyGroups.tsx:269-294`

Even ignoring the sort issue, past in MyGroups is rendered without the month sticky headers used elsewhere. If MyGroups stays around, it should consume `Timeline` for past too (with a `isPastToday` set on items), matching the other feeds.

## Open questions

1. **Are the social tabs the planned future of Plannen, or legacy from a previous multi-user design?** If legacy, recommend deleting `MyFamily.tsx`, `MyFriends.tsx`, `MyGroups.tsx`, `ManageGroups.tsx`, `AddFriend.tsx`, `AddFamilyMember.tsx`, `PendingRequests.tsx` and the corresponding nav entries. Backend routes for `friend_groups` / `family_members` / `relationships` can stay (family_members is used by Profile) but the relationship-request RPCs in the SQL schema can be dropped from the surface. Per [[project_deployment_model]] the answer is "legacy".

2. **Is the `family_members` profile table (Settings → ProfileFamilyMembers) the canonical "my family" concept?** It looks that way — it carries name/relation/dob/gender/goals/interests and is owned per-user. If so, "My Family" tab should either redirect to that screen or be removed. The two surfaces sharing the word "family" but modelling different things is the most confusing thing in the audit.

3. **Should `createGroup` even be reachable when membership/rename/delete are stubbed?** Today the only effect is orphan rows in `plannen.friend_groups`. Either feature-gate the form or finish the routes.

4. **Should `pendingFamilyCount` / `pendingFriendsCount` be removed?** They drive a UI badge that can never render. Dead state.

5. **For MyFeed: should the `getPreferredVisitDates` N+1 be solved at the API or the client layer?** The comment in `rsvpService.ts:11` says "v0 REST contract exposes a single-event GET only" — the fix is presumably a `POST /api/rsvp/batch` accepting event_ids. Until that ships, MyFeed pays 500 round-trips per reload.

6. **Does `viewMode === 'calendar'` belong on MyFeed only, or should it propagate to MyFamily/MyFriends/MyGroups?** It's currently MyFeed-only; the other three only show the Compact/Detailed toggle. If groups/family are deleted this is moot, but worth noting.

7. **Was `MyGroups`'s direct `supabase.from(...)` access intentional, or an artifact of porting?** It is the only feed component that bypasses `dbClient`. If MyGroups stays, this should move into the dbClient/tier1 layer.
