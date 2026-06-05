# My Groups — Mobile UX Compaction

**Date:** 2026-05-22
**Type:** UX — compacts the top of the My Groups page on mobile.
**Status:** Approved — implementing on a new branch off `main`.

## Problem

On mobile, the My Groups page stacks four chunks above the first event:

1. Title + Compact/Calendar toggle
2. Full-width "Manage groups" button (its own row)
3. Optional "Showing only X" banner (its own row, when a `group_id` filter is active)
4. A bordered card containing only the search input

Together they take ~200px of vertical chrome before any content is visible. The search input is over-engineered for the typical case (2–5 groups) and duplicates the affordance the new nav star already provides for single-group users. Selection state ("Showing only X") is also redundant once the page exposes the current filter inline.

## Decision

Replace search + selection banner + full-width manage button with a single horizontal **pill row** that combines quick-switch, filter state, and overflow scrolling. Shrink "Manage groups" to a `⚙` icon button next to the view-mode toggle. No layout fork between mobile and desktop — the pill row is good on both.

## End-state

### Layout (mobile and desktop)

```
Row 1:  My Groups              [Compact|Calendar]  ⚙
Row 2:  [All]  [★ Family]  [Cousins]  [Work]  →     ← horizontal scroll on overflow
Row 3:  events list ↓
```

- `My Groups` h2 unchanged.
- Compact/Calendar toggle unchanged.
- `⚙` icon button (lucide `Settings`): replaces the existing full-width "Manage groups" button. `aria-label="Manage groups"`, `title="Manage groups"`. Opens the same `ManageGroups` modal that exists today.
- The "Showing only X" banner (`MyGroups.tsx:237-251`) is removed — the active pill IS the filter state.
- The bordered search card (`MyGroups.tsx:252-262`) is removed.

### Pill row

A new component (inline in `MyGroups.tsx` for now; extract only if it grows) renders the pills from the user's accessible groups.

**Order:**
1. `[All]` — always first
2. Primary group (`★ <name>`) — second, if the user has one set (`profile.primary_group_id`) AND that group is in their accessible list
3. Remaining groups — alphabetical by name

**Container:**
```
flex gap-2 overflow-x-auto pb-2 -mx-4 px-4
```
Full-bleed horizontal scroll on overflow, edge padding so the first/last pills don't kiss the screen edge. `pb-2` leaves room for a faint shadow if pills sit on a tinted background.

**Pill styles:**
- All pills: `inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-full text-sm font-medium whitespace-nowrap flex-shrink-0`
- Inactive: `bg-gray-100 text-gray-700 hover:bg-gray-200`
- Active: `bg-indigo-600 text-white`
- Star icon inside the primary pill: `Star` from lucide, `h-3.5 w-3.5 fill-current` — same as the existing nav star (`Navigation.tsx:100`)

**Tap behavior:**
- `[All]` → `navigate('/dashboard?view=groups')` (clears `group_id` param)
- Any group pill → `navigate('/dashboard?view=groups&group_id=<id>')`
- Tapping the currently-active pill clears the filter (same URL change as tapping `[All]`)
- Identical URL contract to the nav star (`Navigation.tsx:89-106`) — bidirectional sync for free, no extra wiring

**Accessibility:**
- Pills are `<button>` elements
- Active pill: `aria-pressed="true"`
- `aria-label` includes group name + "(primary group)" for the starred pill

### Data source

The pill row is populated by a new effect that calls `getMyGroups()` once on mount (and again when the Manage modal closes, to pick up newly created/renamed groups).

Post-PR #62, `getMyGroups()` already returns the full set of groups the user can see — both groups they own and groups they're a member of — surfaced by RLS in `friend_groups`. The legacy union with `friend_group_members` inside `loadEventGroupsContext` is redundant after #62 and is not needed for the pill row. The new effect early-returns when `TIER === '0'` (My Groups is hidden there).

No new service call. No new hook (the existing `usePrimaryGroup` is for the nav; pills read `profile.primary_group_id` directly via `useAuth`).

### Edge cases

| Case | Behavior |
|------|----------|
| 0 accessible groups | Hide the pill row entirely. The existing empty-state copy ("No events shared with any of your groups yet…") covers the create-a-group CTA via the `⚙` icon. |
| 1 group | Row shows `[All]` + `[★ <group>]` (the single-group fallback shipped in #62 also pins this group in the nav). |
| 10+ groups | Horizontal scroll. Optional polish: a right-edge fade gradient as a scroll hint — defer unless needed. |
| Group deleted while filter active | `group_id` param no longer matches any pill; row shows no active pill (effectively "All" view). The filter result already handles this — no broken UI. |
| Tier 0 | My Groups page is hidden in Tier 0 today; pill row inherits that — no special-casing. |

### What is removed

From `src/components/MyGroups.tsx`:

- `useState<string>('')` for `groupSearch` (line 30)
- `normalizedGroupSearch` derivation (line 145)
- The `.filter((e) => ... name match)` step that consumes it inside `filteredEvents`
- "Showing only X" banner block (lines 237-251)
- Bordered search card (lines 252-262)
- `matching "{groupSearch}"` segment in the no-results message (line 282)

The full-width "Manage groups" button (lines 228-235) is replaced by a smaller `⚙` icon button in the same flex row as the view-mode toggle.

### Desktop

The pill row works at desktop widths without modification. The previous desktop layout aligned the `Manage groups` button to the right of the header row (`sm:items-center sm:justify-between`); the `⚙` icon takes its place. Pills wrap to no more than one row on desktop in practice (≤ 10 groups), and scroll horizontally if they exceed — same as mobile.

## Judgment calls

These were called out at brainstorm time and approved:

1. Order is `[All]` → primary → alphabetical. Predictable, not by recency or event-count.
2. Tapping the active pill toggles it off (iOS-like).
3. Settings cog icon (`⚙`) over pencil or `UsersRound`. "Manage groups" reads more as settings than as people.
4. Title font size unchanged — the search-card and banner removals already buy enough height.

## Non-goals

- Search by group name. If users with 20+ groups complain, re-add as an icon-collapsed input. YAGNI for now.
- Reordering pills by recency / drag-and-drop. Out of scope.
- Multi-group filter (intersection or union). Out of scope.
- Touching the hashtag filter banner that appears inside the events list — that's separate UX.
