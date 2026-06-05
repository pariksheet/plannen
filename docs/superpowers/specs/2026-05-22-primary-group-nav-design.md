# Primary Group in Navigation

**Date:** 2026-05-22
**Type:** Feature — surfaces a user-pinned group in the top nav.
**Status:** Approved — implementing on `fix/plannen_ui_2226`.

## Problem

A user with one or two frequently-used groups has to go through "My Groups" every time to land on the shared events for that group. The most common case in practice is a household — one group ("Family") that the user lives in. There's currently no way to pin it.

## Decision

Add a `primary_group_id` per-user preference. When set, render a nav tab with the group's name immediately before "My Groups". Tab navigates to `MyGroups` pre-filtered to that single group via URL param. Hide entirely in Tier 0 (groups are already hidden there).

Auto-promotion: when a user creates their first group, set it as their primary in the same call. No DB trigger — the auto-promote lives at the one createGroup callsite, keeping the logic readable.

## End-state

### Schema

New forward-only migration `supabase/migrations/20260522115547_add_primary_group_id_to_users.sql`:

```sql
ALTER TABLE plannen.users
  ADD COLUMN primary_group_id uuid NULL
    REFERENCES plannen.friend_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_primary_group_id
  ON plannen.users(primary_group_id);
```

`ON DELETE SET NULL` covers the "user deletes their primary" case: column clears, nav tab disappears.

### Service layer (`src/services/groupService.ts`)

- New `setPrimaryGroupId(id: string | null): Promise<{ error: Error | null }>`. Tier 1+ writes `plannen.users.primary_group_id` via supabase-js scoped to `auth.uid()`. Tier 0 silently returns no error (groups don't exist there).
- `createGroup()` is augmented: after a successful insert, if the user has no `primary_group_id` set, set it to the new group's id. The check is "is current primary null?", which also handles edge cases like a user who unset their primary and is creating a new group.

### AuthContext (`src/context/AuthContext.tsx`)

- Extend `UserProfile` with `primary_group_id: string | null`.
- Update both load paths (Tier 0 `/api/me` and Tier 1+ supabase select) to populate the field. Tier 0 always supplies `null`.
- Existing `refreshProfile()` is the mechanism callers use to re-pull the profile after `setPrimaryGroupId` or auto-promote-on-create.

### usePrimaryGroup hook (`src/hooks/usePrimaryGroup.ts`)

New hook. Reads `profile.primary_group_id` from `useAuth()` and resolves the name via `getMyGroups()`. Returns `{ id, name } | null`. Re-fetches when the profile changes. If the id no longer resolves (deleted between profile load and now), returns `null` rather than rendering a broken tab.

### Navigation (`src/components/Navigation.tsx`)

- Call `usePrimaryGroup()`. If non-null and `showSocialTabs` is true, prepend an entry immediately before the `groups` tab.
- The primary-group entry navigates to `/dashboard?view=groups&group_id=<id>` via `react-router-dom` `Link` (not `onViewChange`), because it carries a query param.
- Active state: lights up when `view=groups` AND `group_id === primary.id`.
- Mobile menu mirrors the desktop nav.

### MyGroups (`src/components/MyGroups.tsx`)

- Read `searchParams.get('group_id')` on mount and on URL change.
- When set, filter events to those where `eventGroupIdsByEventId[event.id]?.includes(selectedGroupId)`.
- Show a "Showing only: <group name>" chip with × to clear (clearing navigates to `?view=groups` without the param).
- Existing text-search `groupSearch` filter composes with the new id filter.

### ManageGroups (`src/components/ManageGroups.tsx`)

- Each group row gets a star icon. Filled star = current primary, outlined = not. Clicking an outlined star calls `setPrimaryGroupId(groupId)` and refreshes the profile.
- When the user has exactly one group, the star is filled but non-interactive (the auto-promote already set it; nothing to switch to).
- When the user has 2+, every row's star is interactive.

### Tier handling

- Tier 0: no schema reference in the dbClient path; service methods are no-ops; `usePrimaryGroup()` returns `null` (no profile field); nav stays as-is.
- Tier 1+: full feature.

## Out of scope

- No "primary group" surfaces on Today, Profile, Settings.
- No rename of "My Groups".
- No primary-group defaulting on event creation.
- No multi-primary or rank/order — exactly one primary or none.

## Rollout

1. Migration applies via `npx plannen migrate` (Tier 2: `supabase db push --project-ref`).
2. Existing users land with `primary_group_id = NULL`. The first group create after the migration auto-promotes. Users with multiple existing groups stay at NULL until they explicitly pick a primary via ManageGroups.
