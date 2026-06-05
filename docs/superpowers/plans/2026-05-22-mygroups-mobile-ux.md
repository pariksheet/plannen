# My Groups Mobile UX Compaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the search input, "Showing only X" banner, and full-width "Manage groups" button at the top of `MyGroups` with a single horizontal pill row plus a gear icon, reclaiming ~200px of mobile chrome.

**Architecture:** Pure UI refactor inside `src/components/MyGroups.tsx`. Adds one new state (`accessibleGroups`) populated by a new effect that calls `getMyGroups()` directly. The pill row is an inline JSX block. URL contract (`?view=groups&group_id=<id>`) is unchanged — the existing nav star already uses it, so bidirectional sync is automatic.

**Tech Stack:** React 18, TypeScript, React Router v6 (`useSearchParams` / `useNavigate`), Tailwind CSS, lucide-react icons. Vitest + React Testing Library for tests (limited use here — primary verification is manual browser per `CLAUDE.md` guidance for UI).

**Spec:** `docs/superpowers/specs/2026-05-22-mygroups-mobile-ux-design.md`

**Branch:** Already on `feat/mygroups_mobile_ux` (spec was committed there).

---

## File Structure

**Modify only:** `src/components/MyGroups.tsx`

No new files. No service-layer changes. No tests added — there is no existing `tests/components/MyGroups.test.tsx`, and the per-component test convention in this repo is sparse (only `MyFeed`, `EventCard`, `MyStories` have tests, and they require non-trivial mocking that isn't justified for this scope). Manual browser verification is the primary gate.

---

## Task 1: Add `accessibleGroups` state and effect

**Why:** The pill row needs an ordered list of `{id, name}` for groups the user can see. The existing `groupNamesById` Record is populated inside `loadEventGroupsContext`, which only runs when there is at least one event. A user with groups but no shared events would see no pills. New effect fetches groups independently.

**Files:**
- Modify: `src/components/MyGroups.tsx`

- [ ] **Step 1: Add the state declaration**

In the existing state block (currently lines 23–42), add a new state below `eventGroupIdsByEventId` (line 35) and above `showManageModal` (line 36):

```tsx
const [accessibleGroups, setAccessibleGroups] = useState<{ id: string; name: string }[]>([])
```

- [ ] **Step 2: Add a fetch effect**

After the existing `useEffect` block that loads events (currently ends around line 75), add a new effect:

```tsx
useEffect(() => {
  if (TIER === '0') {
    setAccessibleGroups([])
    return
  }
  let cancelled = false
  void (async () => {
    const { data } = await getMyGroups()
    if (cancelled) return
    const sorted = [...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
    setAccessibleGroups(sorted.map((g) => ({ id: g.id, name: g.name })))
  })()
  return () => { cancelled = true }
}, [showManageModal])
```

`showManageModal` is in the dep array so the list refreshes when the user creates / renames a group inside the modal and closes it. `getMyGroups()` is already imported (line 16).

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add src/components/MyGroups.tsx
git commit -m "feat(my-groups): add accessibleGroups state + fetch effect"
```

---

## Task 2: Render the pill row (visual only, no click handlers yet)

**Why:** Get the visual scaffolding on screen before wiring interaction. Easier to debug layout in isolation.

**Files:**
- Modify: `src/components/MyGroups.tsx`

- [ ] **Step 1: Update lucide-react imports**

Change line 14 from:

```tsx
import { ChevronUp, UsersRound, X } from 'lucide-react'
```

to:

```tsx
import { ChevronUp, Settings, Star, UsersRound, X } from 'lucide-react'
```

(`UsersRound` and `X` are removed in later tasks once their last usages disappear. Adding `Settings` and `Star` now keeps unrelated import noise out of those later commits.)

- [ ] **Step 2: Add helper derivation just below the existing `selectedGroupName` line**

Find the line currently around 155:

```tsx
const selectedGroupName = selectedGroupId ? (groupNamesById[selectedGroupId] ?? null) : null
```

Add immediately below:

```tsx
const primaryGroupId = profile?.primary_group_id ?? null
const pillGroups = (() => {
  if (accessibleGroups.length === 0) return []
  const primary = primaryGroupId ? accessibleGroups.find((g) => g.id === primaryGroupId) : null
  const rest = accessibleGroups.filter((g) => g.id !== primary?.id)
  return primary ? [primary, ...rest] : rest
})()
```

This requires `profile` from `useAuth()`. The current `useAuth()` call is `useAuth()` without destructuring (line 19) — change line 19 from:

```tsx
useAuth()
```

to:

```tsx
const { profile } = useAuth()
```

- [ ] **Step 3: Insert the pill row JSX between the header row and the search card**

After the closing `</div>` of the header row (currently line 236, the one that ends the `<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">` block), and before the `{selectedGroupId && ...}` banner (currently line 237), insert:

```tsx
{pillGroups.length > 0 && (
  <div className="w-full max-w-2xl mx-auto -mx-4 px-4 sm:mx-auto sm:px-0">
    <div className="flex gap-2 overflow-x-auto pb-2">
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium whitespace-nowrap flex-shrink-0 ${
          !selectedGroupId ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        }`}
        aria-pressed={!selectedGroupId}
      >
        All
      </button>
      {pillGroups.map((g) => {
        const isActive = selectedGroupId === g.id
        const isPrimary = primaryGroupId === g.id
        return (
          <button
            key={g.id}
            type="button"
            className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium whitespace-nowrap flex-shrink-0 ${
              isActive ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            aria-pressed={isActive}
            aria-label={isPrimary ? `${g.name} (primary group)` : g.name}
          >
            {isPrimary && <Star className="h-3.5 w-3.5 fill-current" aria-hidden />}
            <span className="max-w-[160px] truncate">{g.name}</span>
          </button>
        )
      })}
    </div>
  </div>
)}
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/components/MyGroups.tsx
git commit -m "feat(my-groups): render pill row above events (no nav yet)"
```

---

## Task 3: Wire pill click handlers to navigate

**Why:** Pills are inert in Task 2. This task hooks them up to `useNavigate` so they actually filter, matching the URL contract used by the nav star.

**Files:**
- Modify: `src/components/MyGroups.tsx`

- [ ] **Step 1: Add `onClick` to the `[All]` button**

In the JSX added in Task 2, find the `[All]` button block. Add `onClick`:

```tsx
<button
  type="button"
  onClick={() => navigate('/dashboard?view=groups')}
  className={`...`}
  aria-pressed={!selectedGroupId}
>
  All
</button>
```

`navigate` is already in scope (line 21).

- [ ] **Step 2: Add `onClick` to each group pill**

In the `pillGroups.map` block, add `onClick`:

```tsx
<button
  key={g.id}
  type="button"
  onClick={() => {
    if (isActive) {
      navigate('/dashboard?view=groups')
    } else {
      navigate(`/dashboard?view=groups&group_id=${g.id}`)
    }
  }}
  className={`...`}
  aria-pressed={isActive}
  aria-label={isPrimary ? `${g.name} (primary group)` : g.name}
>
  ...
</button>
```

Tapping the currently-active pill clears the filter (same target URL as `[All]`). Tapping an inactive pill sets it as the filter.

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/components/MyGroups.tsx
git commit -m "feat(my-groups): wire pill row navigation via useNavigate"
```

---

## Task 4: Replace full-width "Manage groups" button with a gear icon

**Why:** Free up the row of vertical space the button currently occupies on mobile. The gear icon sits next to the Compact/Calendar toggle in the same row as the title on mobile.

**Files:**
- Modify: `src/components/MyGroups.tsx`

- [ ] **Step 1: Restructure the header row**

Find the existing header row (currently lines 208–236). Replace the entire outer block:

```tsx
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
  <div>
    <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Groups</h2>
    <div className="mt-2 inline-flex rounded-md border border-gray-300 bg-white p-0.5">
      <button
        type="button"
        onClick={() => setViewMode('compact')}
        className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'compact' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
      >
        Compact
      </button>
      <button
        type="button"
        onClick={() => setViewMode('calendar')}
        className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'calendar' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
      >
        Calendar
      </button>
    </div>
  </div>
  <button
    type="button"
    onClick={() => setShowManageModal(true)}
    className="inline-flex items-center min-h-[44px] py-2.5 px-4 border border-indigo-600 text-indigo-700 font-medium rounded-md hover:bg-indigo-50 text-sm sm:text-base w-full sm:w-auto justify-center"
  >
    <UsersRound className="h-5 w-5 mr-2" />
    Manage groups
  </button>
</div>
```

with:

```tsx
<div className="flex items-center justify-between gap-2 flex-wrap">
  <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">My Groups</h2>
  <div className="flex items-center gap-2">
    <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5">
      <button
        type="button"
        onClick={() => setViewMode('compact')}
        className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'compact' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
      >
        Compact
      </button>
      <button
        type="button"
        onClick={() => setViewMode('calendar')}
        className={`px-3 py-1 text-xs font-medium rounded ${viewMode === 'calendar' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
      >
        Calendar
      </button>
    </div>
    <button
      type="button"
      onClick={() => setShowManageModal(true)}
      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100"
      aria-label="Manage groups"
      title="Manage groups"
    >
      <Settings className="h-5 w-5" />
    </button>
  </div>
</div>
```

Notes:
- Single flex row that wraps on very narrow screens (the `flex-wrap` keeps it readable on a 320px viewport).
- Compact/Calendar toggle and the gear share a sub-flex so they stay together when the title wraps.
- The icon button is `min-h-[44px] min-w-[44px]` to keep the touch target accessible.
- `UsersRound` import is no longer used — drop it from the import line (`import { ChevronUp, Settings, Star, X } from 'lucide-react'`).

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no output. If TypeScript complains about an unused `UsersRound` import, that's the cue to remove it (already covered above).

- [ ] **Step 3: Commit**

```bash
git add src/components/MyGroups.tsx
git commit -m "feat(my-groups): replace Manage groups button with gear icon"
```

---

## Task 5: Remove the search input card, state, and filter step

**Why:** The pill row replaces the search affordance for the common case. Removing the search card alone removes ~80px of vertical chrome on mobile.

**Files:**
- Modify: `src/components/MyGroups.tsx`

- [ ] **Step 1: Remove the `groupSearch` state**

Find and delete (currently line 30):

```tsx
const [groupSearch, setGroupSearch] = useState('')
```

- [ ] **Step 2: Remove the `normalizedGroupSearch` derivation and `matchesGroupSearch` predicate**

Find and delete (currently lines 145–150):

```tsx
const normalizedGroupSearch = groupSearch.trim().toLowerCase()
const matchesGroupSearch = (event: Event) => {
  if (!normalizedGroupSearch) return true
  const groupIds = eventGroupIdsByEventId[event.id] ?? []
  return groupIds.some((groupId) => (groupNamesById[groupId] ?? '').toLowerCase().includes(normalizedGroupSearch))
}
```

- [ ] **Step 3: Remove the search step from `filteredEvents`**

Find the `filteredEvents` derivation (it currently composes `matchesGroupSearch`, `matchesSelectedGroup`, and `activeHashtag` filters). Remove the `.filter(matchesGroupSearch)` call. Example before / after:

Before (illustrative — locate by `filteredEvents` name and remove only the `matchesGroupSearch` line):

```tsx
const filteredEvents = events
  .filter(matchesGroupSearch)
  .filter(matchesSelectedGroup)
  .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
```

After:

```tsx
const filteredEvents = events
  .filter(matchesSelectedGroup)
  .filter((e) => !activeHashtag || (e.hashtags ?? []).includes(activeHashtag))
```

- [ ] **Step 4: Remove the bordered search card JSX**

Find and delete (currently lines 252–262):

```tsx
<div className="w-full max-w-2xl mx-auto min-w-0 bg-white rounded-lg border border-gray-200 p-4">
  <div className="flex gap-2 min-w-0 flex-wrap sm:flex-nowrap">
    <input
      type="text"
      value={groupSearch}
      onChange={(e) => setGroupSearch(e.target.value)}
      placeholder="Search group name"
      className="flex-1 min-w-0 px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
    />
  </div>
</div>
```

- [ ] **Step 5: Update the no-results message**

Find the no-results block (currently lines 277–283). Remove the `matching "{groupSearch}"` segment:

Before:

```tsx
<p className="text-gray-500 mb-4">
  No group events found
  {selectedGroupName ? ` for ${selectedGroupName}` : ''}
  {activeHashtag ? ` for #${activeHashtag}` : ''}
  {normalizedGroupSearch ? ` matching "${groupSearch}"` : ''}.
</p>
```

After:

```tsx
<p className="text-gray-500 mb-4">
  No group events found
  {selectedGroupName ? ` for ${selectedGroupName}` : ''}
  {activeHashtag ? ` for #${activeHashtag}` : ''}.
</p>
```

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no output. (If TS complains about `setGroupSearch`/`groupSearch` somewhere else, search the file — there should be no other references after the deletions above.)

- [ ] **Step 7: Commit**

```bash
git add src/components/MyGroups.tsx
git commit -m "feat(my-groups): remove search input, state, and filter step"
```

---

## Task 6: Remove the "Showing only X" banner

**Why:** The active pill is now the filter affordance. The blue banner is redundant chrome.

**Files:**
- Modify: `src/components/MyGroups.tsx`

- [ ] **Step 1: Delete the banner block**

Find and delete (currently lines 237–251):

```tsx
{selectedGroupId && (
  <div className="w-full max-w-2xl mx-auto flex items-center justify-between gap-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2">
    <p className="text-sm text-indigo-800">
      Showing only <span className="font-semibold">{selectedGroupName ?? 'this group'}</span>
    </p>
    <button
      type="button"
      onClick={() => navigate('/dashboard?view=groups')}
      aria-label="Clear group filter"
      className="inline-flex items-center justify-center min-h-[36px] min-w-[36px] rounded-md text-indigo-700 hover:bg-indigo-100"
    >
      <X className="h-4 w-4" />
    </button>
  </div>
)}
```

- [ ] **Step 2: Drop the now-unused `X` icon from the lucide-react import**

If line 14 currently reads `import { ChevronUp, Settings, Star, X } from 'lucide-react'`, change to:

```tsx
import { ChevronUp, Settings, Star } from 'lucide-react'
```

(Verify no other `<X` usage remains in the file: `grep -n "<X\b" src/components/MyGroups.tsx` — expected: no matches.)

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/components/MyGroups.tsx
git commit -m "feat(my-groups): remove redundant 'Showing only X' banner"
```

---

## Task 7: Manual browser verification

**Why:** This is a UI change; per `CLAUDE.md`, the dev server / browser is the verification gate. The repo has no `MyGroups` unit test to lean on.

**Setup:**

- [ ] **Step 1: Start dev**

```bash
npm run dev
```

Expected: Vite starts on `http://localhost:4321` (port pinned per `CLAUDE.md`).

- [ ] **Step 2: Open `/dashboard?view=groups` in the browser**

Log in (or be logged in) as a user with at least one group. The active profile is `sb_prod` — use a real account.

**Checks (mobile width — set browser to 375px):**

- [ ] **Step 3: Pill row appears with `[All]` + each accessible group**

- `[All]` is leftmost.
- If `profile.primary_group_id` is set and matches a group, that group is second with a star.
- Other groups follow alphabetically.

- [ ] **Step 4: Active pill highlights**

- Land without `group_id` in URL → `[All]` is `bg-indigo-600 text-white`, others gray.
- Tap a group pill → URL becomes `?view=groups&group_id=<id>`, that pill turns indigo, `[All]` turns gray. Events list filters down.
- Tap the same active pill again → URL drops `group_id`, back to `[All]` highlighted. Events list shows all.

- [ ] **Step 5: Nav star and pill stay in sync**

- Tap the nav star (primary group) → the primary pill highlights, `[All]` deactivates.
- Tap `[All]` → nav star "all-groups" view becomes active. URL contract is shared.

- [ ] **Step 6: Gear icon opens the Manage modal**

- Tap the gear icon (top-right of header) → `ManageGroups` modal opens. Close it → modal closes. (Creating/renaming a group inside the modal should make the pill row refresh on close, per the Task 1 effect dep.)

- [ ] **Step 7: Old chrome is gone**

- No search input visible.
- No "Showing only X" blue banner when a group is filtered (active pill is the only indicator).
- No full-width "Manage groups" button below the header.

- [ ] **Step 8: Desktop check (≥1024px width)**

- Same pill row renders, fits in one row without horizontal scroll for ≤ ~6 groups.
- Header row stays single-row: title + view toggle + gear.

- [ ] **Step 9: 0-groups edge case**

- If you have access to a test account with no groups: pill row is absent. Empty-state copy says "No events shared with any of your groups yet…" and the gear is still tappable to open Manage and create a first group.
- If you can't easily produce this state, skip the live check but confirm in code that `pillGroups.length === 0` returns no JSX (Task 2 wraps the row in `{pillGroups.length > 0 && ...}`).

- [ ] **Step 10: Many-groups edge case (optional)**

- Open Manage, create a few extra groups so the pill row overflows. Confirm horizontal scroll works on mobile.

- [ ] **Step 11: Commit (if any post-verify polish lands)**

If the manual pass surfaces a tweak (e.g., a spacing nit), apply it and commit. Otherwise skip.

---

## Self-Review

**Spec coverage:**
- Layout (mobile + desktop): Task 4 (header row) + Task 2 (pill row) ✓
- Pill row order (All → primary → alphabetical): Task 2 step 2 (pillGroups derivation) ✓
- Pill styles (active vs inactive): Task 2 step 3 ✓
- Tap behavior (toggle-off): Task 3 ✓
- A11y (`aria-pressed`, `aria-label`): Task 2 step 3 ✓
- Data source (use existing `getMyGroups()`): Task 1 ✓
- Edge cases (0 groups hidden, 1 group still works, deleted group): Task 2 step 3 wraps in `pillGroups.length > 0`; deleted group ⇒ no pill highlights (free) ✓
- Removed: search card + state + filter (Task 5), banner (Task 6), full-width Manage button (Task 4) ✓
- Desktop layout: covered in Task 4 + manual verify Step 8 ✓
- Tier 0 hidden: Task 1 step 2 early-returns when `TIER === '0'` ✓
- Judgment calls (settings cog, toggle-off, alpha order): all encoded in Tasks 2–4 ✓
- Non-goals (search, recency ordering, multi-group filter): not implemented ✓

**Placeholder scan:** no TBD / TODO / "implement later" entries. All code blocks are concrete.

**Type consistency:** `accessibleGroups: { id: string; name: string }[]` used consistently across Tasks 1–3. `pillGroups` derivation in Task 2 matches the same shape. `selectedGroupId` is the existing `string | null` from `searchParams.get('group_id')`. `primaryGroupId` is read from `profile?.primary_group_id ?? null` consistent with `usePrimaryGroup` (`src/hooks/usePrimaryGroup.ts:22`).
