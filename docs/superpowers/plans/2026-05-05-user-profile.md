# User Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private user profile (DOB, goals, interests, multiple locations, offline family members) surfaced to Claude via a new `get_profile_context` MCP tool so natural-language queries like "swimming classes for my son near home" resolve correctly.

**Architecture:** Three new Supabase tables (`user_profiles`, `user_locations`, `family_members`) all private via RLS. A new `/profile` React page with four collapsible sections. Six new MCP tools (pure data, no AI) added to `mcp/src/index.ts` following the exact same pattern as existing tools.

**Tech Stack:** TypeScript, React, Tailwind CSS, Supabase (PostgreSQL + RLS), MCP SDK (`@modelcontextprotocol/sdk`)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `supabase/migrations/025_user_profile.sql` | 3 new tables + RLS + partial unique index |
| Create | `src/services/profileService.ts` | All profile CRUD via Supabase client |
| Create | `src/pages/Profile.tsx` | `/profile` page — composes the 4 section components |
| Create | `src/components/ProfilePersonalInfo.tsx` | DOB field + full name (read-only from users table) |
| Create | `src/components/ProfileLocations.tsx` | Add/edit/delete locations, set default |
| Create | `src/components/ProfileInterestsGoals.tsx` | Pill tags for interests, list entries for goals |
| Create | `src/components/ProfileFamilyMembers.tsx` | Add/edit/delete offline family members |
| Modify | `src/routes/AppRoutes.tsx` | Add `/profile` protected route |
| Modify | `src/components/Navigation.tsx` | Add "My Profile" link from avatar area |
| Modify | `mcp/src/index.ts` | Add 6 profile tools + wire into switch + TOOLS array |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/025_user_profile.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/025_user_profile.sql

-- 1. user_profiles (1-to-1 with users)
CREATE TABLE public.user_profiles (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  dob     DATE,
  goals   TEXT[] NOT NULL DEFAULT '{}',
  interests TEXT[] NOT NULL DEFAULT '{}'
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_profiles: owner only"
  ON public.user_profiles FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 2. user_locations (1-to-many)
CREATE TABLE public.user_locations (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  city       TEXT NOT NULL DEFAULT '',
  country    TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one default location per user
CREATE UNIQUE INDEX user_locations_one_default
  ON public.user_locations (user_id)
  WHERE is_default = true;

CREATE INDEX idx_user_locations_user_id ON public.user_locations (user_id);

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_locations: owner only"
  ON public.user_locations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. family_members (offline — not Plannen users)
CREATE TABLE public.family_members (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  relation   TEXT NOT NULL,
  dob        DATE,
  gender     TEXT,
  goals      TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_family_members_user_id ON public.family_members (user_id);

ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "family_members: owner only"
  ON public.family_members FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

- [ ] **Step 2: Apply migration locally**

```bash
supabase db reset
```

Expected: migrations replay cleanly, no errors. Check the output for any SQLSTATE errors.

- [ ] **Step 3: Verify tables exist**

```bash
supabase db diff --local 2>/dev/null | head -5
# or open Supabase Studio at http://localhost:54323 → Table Editor
# confirm user_profiles, user_locations, family_members appear
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/025_user_profile.sql
git commit -m "feat(db): add user_profiles, user_locations, family_members tables"
```

---

## Task 2: Profile Service

**Files:**
- Create: `src/services/profileService.ts`

- [ ] **Step 1: Write the service**

```typescript
// src/services/profileService.ts
import { supabase } from '../lib/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserProfile {
  user_id: string
  dob: string | null
  goals: string[]
  interests: string[]
}

export interface UserLocation {
  id: string
  user_id: string
  label: string
  address: string
  city: string
  country: string
  is_default: boolean
}

export interface FamilyMember {
  id: string
  user_id: string
  name: string
  relation: string
  dob: string | null
  gender: string | null
  goals: string[]
}

// ── user_profiles ─────────────────────────────────────────────────────────────

export async function getProfile(): Promise<{ data: UserProfile | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as UserProfile | null, error: null }
}

export async function upsertProfile(
  updates: { dob?: string | null; goals?: string[]; interests?: string[] }
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, ...updates }, { onConflict: 'user_id' })
  return { error: error ? new Error(error.message) : null }
}

// ── user_locations ────────────────────────────────────────────────────────────

export async function getLocations(): Promise<{ data: UserLocation[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('user_locations')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as UserLocation[], error: null }
}

export async function addLocation(
  loc: { label: string; address: string; city: string; country: string; is_default: boolean }
): Promise<{ data: UserLocation | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  if (loc.is_default) {
    await supabase.from('user_locations').update({ is_default: false }).eq('user_id', user.id)
  }
  const { data, error } = await supabase
    .from('user_locations')
    .insert({ user_id: user.id, ...loc })
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as UserLocation, error: null }
}

export async function updateLocation(
  id: string,
  updates: Partial<Pick<UserLocation, 'label' | 'address' | 'city' | 'country' | 'is_default'>>
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  if (updates.is_default) {
    await supabase.from('user_locations').update({ is_default: false }).eq('user_id', user.id)
  }
  const { error } = await supabase
    .from('user_locations')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}

export async function deleteLocation(id: string): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('user_locations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}

// ── family_members ────────────────────────────────────────────────────────────

export async function getFamilyMembers(): Promise<{ data: FamilyMember[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('family_members')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as FamilyMember[], error: null }
}

export async function addFamilyMember(
  member: { name: string; relation: string; dob?: string | null; gender?: string | null; goals?: string[] }
): Promise<{ data: FamilyMember | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('family_members')
    .insert({ user_id: user.id, goals: [], ...member })
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as FamilyMember, error: null }
}

export async function updateFamilyMember(
  id: string,
  updates: Partial<Pick<FamilyMember, 'name' | 'relation' | 'dob' | 'gender' | 'goals'>>
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('family_members')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}

export async function deleteFamilyMember(id: string): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('family_members')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/services/profileService.ts
git commit -m "feat(profile): add profileService — CRUD for user_profiles, user_locations, family_members"
```

---

## Task 3: MCP Profile Tools

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add the 6 tool implementation functions**

After the `listRelationships` function (around line 355), add:

```typescript
// ── Profile tools ─────────────────────────────────────────────────────────────

function computeAge(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  const today = new Date()
  const age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) return age - 1
  return age
}

async function getProfileContext() {
  const id = await uid()
  const [profileRes, locationsRes, familyRes] = await Promise.all([
    db.from('user_profiles').select('dob, goals, interests').eq('user_id', id).maybeSingle(),
    db.from('user_locations').select('label, city, country, is_default').eq('user_id', id).order('created_at', { ascending: true }),
    db.from('family_members').select('name, relation, dob, gender, goals').eq('user_id', id).order('created_at', { ascending: true }),
  ])
  if (profileRes.error) throw new Error(profileRes.error.message)
  if (locationsRes.error) throw new Error(locationsRes.error.message)
  if (familyRes.error) throw new Error(familyRes.error.message)

  return {
    goals: profileRes.data?.goals ?? [],
    interests: profileRes.data?.interests ?? [],
    locations: (locationsRes.data ?? []).map((l) => ({
      label: l.label,
      city: l.city,
      country: l.country,
      is_default: l.is_default,
    })),
    family_members: (familyRes.data ?? []).map((m) => ({
      name: m.name,
      relation: m.relation,
      age: computeAge(m.dob),
      gender: m.gender,
      goals: m.goals,
    })),
  }
}

async function updateProfile(args: { dob?: string | null; goals?: string[]; interests?: string[] }) {
  const id = await uid()
  const payload: Record<string, unknown> = { user_id: id }
  if (args.dob !== undefined) payload.dob = args.dob
  if (args.goals !== undefined) payload.goals = args.goals
  if (args.interests !== undefined) payload.interests = args.interests
  const { error } = await db
    .from('user_profiles')
    .upsert(payload, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
  return { success: true }
}

async function addFamilyMember(args: {
  name: string
  relation: string
  dob?: string | null
  gender?: string | null
  goals?: string[]
}) {
  const id = await uid()
  const { data, error } = await db
    .from('family_members')
    .insert({ user_id: id, goals: [], ...args })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function listFamilyMembers() {
  const id = await uid()
  const { data, error } = await db
    .from('family_members')
    .select('id, name, relation, dob, gender, goals')
    .eq('user_id', id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map((m) => ({ ...m, age: computeAge(m.dob) }))
}

async function addLocation(args: {
  label: string
  address?: string
  city?: string
  country?: string
  is_default?: boolean
}) {
  const id = await uid()
  if (args.is_default) {
    await db.from('user_locations').update({ is_default: false }).eq('user_id', id)
  }
  const { data, error } = await db
    .from('user_locations')
    .insert({
      user_id: id,
      label: args.label,
      address: args.address ?? '',
      city: args.city ?? '',
      country: args.country ?? '',
      is_default: args.is_default ?? false,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function listLocations() {
  const id = await uid()
  const { data, error } = await db
    .from('user_locations')
    .select('id, label, address, city, country, is_default')
    .eq('user_id', id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}
```

- [ ] **Step 2: Add the 6 tools to the TOOLS array**

In the `TOOLS` array (after the `list_relationships` tool entry), add:

```typescript
  {
    name: 'get_profile_context',
    description:
      'Return the user\'s profile context for AI-assisted event discovery: saved locations (label + city only), interests, goals, and offline family members with computed ages. Call this when the user\'s query references "my son", "near home", or similar personal context.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_profile',
    description: 'Save or update the user\'s profile: date of birth, personal goals, and interests.',
    inputSchema: {
      type: 'object',
      properties: {
        dob: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD, or null to clear' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Free-text personal goals (replaces existing list)' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Free-text interest tags (replaces existing list)' },
      },
    },
  },
  {
    name: 'add_family_member',
    description: 'Add an offline family member (someone who does not have a Plannen account, e.g. a child).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        relation: { type: 'string', description: 'e.g. "son", "daughter", "mother", "father"' },
        dob: { type: ['string', 'null'], description: 'Date of birth as YYYY-MM-DD' },
        gender: { type: ['string', 'null'], description: 'e.g. "male", "female"' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Goals for this family member' },
      },
      required: ['name', 'relation'],
    },
  },
  {
    name: 'list_family_members',
    description: 'List all offline family members with their computed ages.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_location',
    description: 'Add a named location (e.g. Home, Work) to the user\'s saved locations.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'e.g. "Home", "Work"' },
        address: { type: 'string', description: 'Full address string' },
        city: { type: 'string' },
        country: { type: 'string' },
        is_default: { type: 'boolean', description: 'Set as default location for searches (clears any existing default)' },
      },
      required: ['label'],
    },
  },
  {
    name: 'list_locations',
    description: 'List the user\'s saved locations.',
    inputSchema: { type: 'object', properties: {} },
  },
```

- [ ] **Step 3: Wire the new tools into the switch statement**

In the `switch (name)` block, after the `list_relationships` case, add:

```typescript
      case 'get_profile_context':  result = await getProfileContext(); break
      case 'update_profile':       result = await updateProfile(args as Parameters<typeof updateProfile>[0]); break
      case 'add_family_member':    result = await addFamilyMember(args as Parameters<typeof addFamilyMember>[0]); break
      case 'list_family_members':  result = await listFamilyMembers(); break
      case 'add_location':         result = await addLocation(args as Parameters<typeof addLocation>[0]); break
      case 'list_locations':       result = await listLocations(); break
```

- [ ] **Step 4: Build MCP and verify**

```bash
cd mcp && npm run build
```

Expected: `dist/index.js` produced with no TypeScript errors.

- [ ] **Step 5: Smoke-test from Claude Code**

Ask Claude Code (in this session):
> "Call `list_family_members` from the plannen MCP"

Expected: empty array `[]` (no members yet). If you get a tool error, check the build output.

- [ ] **Step 6: Commit**

```bash
cd .. && git add mcp/src/index.ts mcp/dist/
git commit -m "feat(mcp): add profile tools — get_profile_context, update_profile, add/list family_members, add/list locations"
```

---

## Task 4: Profile Page and Route

**Files:**
- Create: `src/pages/Profile.tsx`
- Modify: `src/routes/AppRoutes.tsx`
- Modify: `src/components/Navigation.tsx`

- [ ] **Step 1: Create the Profile page shell**

```tsx
// src/pages/Profile.tsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ProfilePersonalInfo } from '../components/ProfilePersonalInfo'
import { ProfileLocations } from '../components/ProfileLocations'
import { ProfileInterestsGoals } from '../components/ProfileInterestsGoals'
import { ProfileFamilyMembers } from '../components/ProfileFamilyMembers'
import {
  getProfile, upsertProfile,
  getLocations, addLocation, updateLocation, deleteLocation,
  getFamilyMembers, addFamilyMember, updateFamilyMember, deleteFamilyMember,
  UserProfile, UserLocation, FamilyMember,
} from '../services/profileService'

export function Profile() {
  const { profile: authProfile } = useAuth()

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [locations, setLocations] = useState<UserLocation[]>([])
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([])
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const [p, l, f] = await Promise.all([getProfile(), getLocations(), getFamilyMembers()])
      setUserProfile(p.data)
      setLocations(l.data)
      setFamilyMembers(f.data)
      setLoading(false)
    }
    load()
  }, [])

  async function handleSaveProfile(updates: { dob?: string | null; goals?: string[]; interests?: string[] }) {
    setSaveError(null)
    const { error } = await upsertProfile(updates)
    if (error) { setSaveError(error.message); return }
    const { data } = await getProfile()
    setUserProfile(data)
  }

  async function handleAddLocation(loc: Parameters<typeof addLocation>[0]) {
    const { error } = await addLocation(loc)
    if (error) { setSaveError(error.message); return }
    const { data } = await getLocations()
    setLocations(data)
  }

  async function handleUpdateLocation(id: string, updates: Parameters<typeof updateLocation>[1]) {
    const { error } = await updateLocation(id, updates)
    if (error) { setSaveError(error.message); return }
    const { data } = await getLocations()
    setLocations(data)
  }

  async function handleDeleteLocation(id: string) {
    const { error } = await deleteLocation(id)
    if (error) { setSaveError(error.message); return }
    setLocations((prev) => prev.filter((l) => l.id !== id))
  }

  async function handleAddFamilyMember(member: Parameters<typeof addFamilyMember>[0]) {
    const { error } = await addFamilyMember(member)
    if (error) { setSaveError(error.message); return }
    const { data } = await getFamilyMembers()
    setFamilyMembers(data)
  }

  async function handleUpdateFamilyMember(id: string, updates: Parameters<typeof updateFamilyMember>[1]) {
    const { error } = await updateFamilyMember(id, updates)
    if (error) { setSaveError(error.message); return }
    const { data } = await getFamilyMembers()
    setFamilyMembers(data)
  }

  async function handleDeleteFamilyMember(id: string) {
    const { error } = await deleteFamilyMember(id)
    if (error) { setSaveError(error.message); return }
    setFamilyMembers((prev) => prev.filter((m) => m.id !== id))
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading profile…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link to="/dashboard" className="p-2 rounded-md text-gray-500 hover:bg-gray-100">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>
            <p className="text-sm text-gray-500">Used by Claude to personalise event discovery</p>
          </div>
          {authProfile?.avatar_sticker && (
            <span className="ml-auto text-3xl">{authProfile.avatar_sticker}</span>
          )}
        </div>

        {saveError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {saveError}
          </div>
        )}

        <div className="space-y-4">
          <ProfilePersonalInfo
            fullName={authProfile?.full_name ?? ''}
            dob={userProfile?.dob ?? null}
            onSave={(dob) => handleSaveProfile({ dob })}
          />
          <ProfileLocations
            locations={locations}
            onAdd={handleAddLocation}
            onUpdate={handleUpdateLocation}
            onDelete={handleDeleteLocation}
          />
          <ProfileInterestsGoals
            goals={userProfile?.goals ?? []}
            interests={userProfile?.interests ?? []}
            onSave={(goals, interests) => handleSaveProfile({ goals, interests })}
          />
          <ProfileFamilyMembers
            members={familyMembers}
            onAdd={handleAddFamilyMember}
            onUpdate={handleUpdateFamilyMember}
            onDelete={handleDeleteFamilyMember}
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add `/profile` route to AppRoutes.tsx**

Add the import after the existing page imports:

```tsx
import { Profile } from '../pages/Profile'
```

Add the route inside `<Routes>`, before the final `<Route path="/" …>`:

```tsx
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <Profile />
          </ProtectedRoute>
        }
      />
```

- [ ] **Step 3: Add "My Profile" link in Navigation.tsx**

In the desktop nav, replace the static avatar `<div>` block (lines 69–78) with a `<Link>` that wraps it:

```tsx
          {profile && (
            <Link
              to="/profile"
              className="hidden sm:flex items-center gap-2 max-w-[180px] rounded-md px-2 py-1 hover:bg-gray-100"
              title="My Profile"
            >
              <div className="h-9 w-9 rounded-full bg-indigo-50 flex items-center justify-center text-lg">
                <span>{profile.avatar_sticker || '🙂'}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-900 truncate">
                  {profile.full_name || profile.email || 'You'}
                </span>
              </div>
            </Link>
          )}
```

Also add a "My Profile" entry in the mobile drawer, inside the `<div className="border-t …">` block, as the first item:

```tsx
                <Link
                  to="/profile"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <UserCircle className="h-5 w-5" />
                  My Profile
                </Link>
```

And add the `UserCircle` import to the lucide-react import line:

```tsx
import { Menu, X, LogOut, LayoutDashboard, Users, Handshake, UsersRound, CalendarDays, Shield, Settings, UserCircle } from 'lucide-react'
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. The section components don't exist yet — expect "cannot find module" errors only for those 4 imports. That's fine; resolve them in Tasks 5–8.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Profile.tsx src/routes/AppRoutes.tsx src/components/Navigation.tsx
git commit -m "feat(profile): add /profile page, route, and nav entry point"
```

---

## Task 5: Personal Info Section

**Files:**
- Create: `src/components/ProfilePersonalInfo.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/ProfilePersonalInfo.tsx
import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface Props {
  fullName: string
  dob: string | null
  onSave: (dob: string | null) => Promise<void>
}

export function ProfilePersonalInfo({ fullName, dob, onSave }: Props) {
  const [open, setOpen] = useState(true)
  const [editDob, setEditDob] = useState(dob ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave(editDob || null)
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">Personal Info</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-100">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Full name
            </label>
            <input
              type="text"
              value={fullName}
              disabled
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
            />
            <p className="mt-1 text-xs text-gray-400">Change in onboarding</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Date of birth
            </label>
            <input
              type="date"
              value={editDob}
              onChange={(e) => setEditDob(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: the `ProfilePersonalInfo` import in `Profile.tsx` now resolves. Remaining errors should only be for the other 3 missing section components.

- [ ] **Step 3: Commit**

```bash
git add src/components/ProfilePersonalInfo.tsx
git commit -m "feat(profile): ProfilePersonalInfo section"
```

---

## Task 6: Locations Section

**Files:**
- Create: `src/components/ProfileLocations.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/ProfileLocations.tsx
import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Trash2, MapPin } from 'lucide-react'
import { UserLocation } from '../services/profileService'

interface Props {
  locations: UserLocation[]
  onAdd: (loc: Omit<UserLocation, 'id' | 'user_id'>) => Promise<void>
  onUpdate: (id: string, updates: Partial<Omit<UserLocation, 'id' | 'user_id'>>) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

const EMPTY_FORM = { label: '', address: '', city: '', country: '', is_default: false }

export function ProfileLocations({ locations, onAdd, onUpdate, onDelete }: Props) {
  const [open, setOpen] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  function startAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function startEdit(loc: UserLocation) {
    setEditingId(loc.id)
    setForm({ label: loc.label, address: loc.address, city: loc.city, country: loc.country, is_default: loc.is_default })
    setShowForm(true)
  }

  async function handleSubmit() {
    if (!form.label.trim()) return
    setSaving(true)
    if (editingId) {
      await onUpdate(editingId, form)
    } else {
      await onAdd(form)
    }
    setShowForm(false)
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">My Locations</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-3 pt-4">
          {locations.map((loc) => (
            <div
              key={loc.id}
              className={`flex items-start gap-3 rounded-lg p-3 border ${loc.is_default ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'}`}
            >
              <MapPin className={`h-4 w-4 mt-0.5 flex-shrink-0 ${loc.is_default ? 'text-green-600' : 'text-gray-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900">{loc.label}</span>
                  {loc.is_default && (
                    <span className="text-xs bg-green-600 text-white rounded px-1.5 py-0.5">default</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">{[loc.city, loc.country].filter(Boolean).join(', ') || loc.address}</p>
              </div>
              <button type="button" onClick={() => startEdit(loc)} className="p-1 text-gray-400 hover:text-gray-600">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => onDelete(loc.id)} className="p-1 text-gray-400 hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}

          {showForm && (
            <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Label *</label>
                  <input
                    type="text"
                    placeholder="Home"
                    value={form.label}
                    onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
                  <input
                    type="text"
                    placeholder="Antwerp"
                    value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
                  <input
                    type="text"
                    placeholder="Belgium"
                    value={form.country}
                    onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Full address</label>
                  <input
                    type="text"
                    placeholder="Optional"
                    value={form.address}
                    onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                Set as default for searches
              </label>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving || !form.label.trim()}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {!showForm && (
            <button
              type="button"
              onClick={startAdd}
              className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
            >
              + Add location
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: `ProfileLocations` import now resolves. Two missing section components remain.

- [ ] **Step 3: Commit**

```bash
git add src/components/ProfileLocations.tsx
git commit -m "feat(profile): ProfileLocations section"
```

---

## Task 7: Interests & Goals Section

**Files:**
- Create: `src/components/ProfileInterestsGoals.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/ProfileInterestsGoals.tsx
import { useState, KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

interface Props {
  interests: string[]
  goals: string[]
  onSave: (goals: string[], interests: string[]) => Promise<void>
}

export function ProfileInterestsGoals({ interests, goals, onSave }: Props) {
  const [open, setOpen] = useState(true)
  const [editInterests, setEditInterests] = useState<string[]>(interests)
  const [editGoals, setEditGoals] = useState<string[]>(goals)
  const [interestInput, setInterestInput] = useState('')
  const [goalInput, setGoalInput] = useState('')
  const [saving, setSaving] = useState(false)

  function addInterest() {
    const val = interestInput.trim()
    if (val && !editInterests.includes(val)) {
      setEditInterests((prev) => [...prev, val])
    }
    setInterestInput('')
  }

  function removeInterest(tag: string) {
    setEditInterests((prev) => prev.filter((t) => t !== tag))
  }

  function addGoal() {
    const val = goalInput.trim()
    if (val) setEditGoals((prev) => [...prev, val])
    setGoalInput('')
  }

  function removeGoal(idx: number) {
    setEditGoals((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleInterestKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInterest() }
  }

  function handleGoalKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addGoal() }
  }

  async function handleSave() {
    setSaving(true)
    await onSave(editGoals, editInterests)
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">Interests &amp; Goals</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-5 pt-4">
          {/* Interests */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Interests
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {editInterests.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 bg-violet-100 text-violet-700 rounded-full px-3 py-1 text-sm"
                >
                  {tag}
                  <button type="button" onClick={() => removeInterest(tag)} className="hover:text-violet-900">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              placeholder="Type an interest and press Enter"
              value={interestInput}
              onChange={(e) => setInterestInput(e.target.value)}
              onKeyDown={handleInterestKey}
              onBlur={addInterest}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Goals */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Goals
            </label>
            <div className="space-y-2 mb-2">
              {editGoals.map((goal, idx) => (
                <div key={idx} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  <span className="flex-1 text-sm text-gray-800">{goal}</span>
                  <button type="button" onClick={() => removeGoal(idx)} className="text-gray-400 hover:text-red-500">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <input
              type="text"
              placeholder="Type a goal and press Enter"
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={handleGoalKey}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: one missing section component remains (`ProfileFamilyMembers`).

- [ ] **Step 3: Commit**

```bash
git add src/components/ProfileInterestsGoals.tsx
git commit -m "feat(profile): ProfileInterestsGoals section"
```

---

## Task 8: Family Members Section

**Files:**
- Create: `src/components/ProfileFamilyMembers.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/ProfileFamilyMembers.tsx
import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Trash2, X } from 'lucide-react'
import { FamilyMember } from '../services/profileService'

interface Props {
  members: FamilyMember[]
  onAdd: (member: Omit<FamilyMember, 'id' | 'user_id'>) => Promise<void>
  onUpdate: (id: string, updates: Partial<Omit<FamilyMember, 'id' | 'user_id'>>) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

const EMPTY_FORM = { name: '', relation: '', dob: '', gender: '', goals: [] as string[] }

function computeAge(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const m = today.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
  return age
}

export function ProfileFamilyMembers({ members, onAdd, onUpdate, onDelete }: Props) {
  const [open, setOpen] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [goalInput, setGoalInput] = useState('')
  const [saving, setSaving] = useState(false)

  function startAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setGoalInput('')
    setShowForm(true)
  }

  function startEdit(m: FamilyMember) {
    setEditingId(m.id)
    setForm({ name: m.name, relation: m.relation, dob: m.dob ?? '', gender: m.gender ?? '', goals: [...m.goals] })
    setGoalInput('')
    setShowForm(true)
  }

  function addGoalToForm() {
    const val = goalInput.trim()
    if (val) setForm((f) => ({ ...f, goals: [...f.goals, val] }))
    setGoalInput('')
  }

  function removeGoalFromForm(idx: number) {
    setForm((f) => ({ ...f, goals: f.goals.filter((_, i) => i !== idx) }))
  }

  async function handleSubmit() {
    if (!form.name.trim() || !form.relation.trim()) return
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      relation: form.relation.trim(),
      dob: form.dob || null,
      gender: form.gender || null,
      goals: form.goals,
    }
    if (editingId) {
      await onUpdate(editingId, payload)
    } else {
      await onAdd(payload)
    }
    setShowForm(false)
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">Family Members</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-3 pt-4">
          <p className="text-xs text-gray-500">
            Offline family members (people without a Plannen account). Used by Claude for age-appropriate suggestions.
          </p>

          {members.map((m) => {
            const age = computeAge(m.dob)
            return (
              <div key={m.id} className="flex items-start gap-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
                <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center text-base flex-shrink-0">
                  {m.gender === 'male' ? '👦' : m.gender === 'female' ? '👧' : '🧒'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {m.name}
                    <span className="font-normal text-gray-500 ml-1">
                      · {m.relation}{age !== null ? ` · ${age} yrs` : ''}
                    </span>
                  </p>
                  {m.goals.length > 0 && (
                    <p className="text-xs text-gray-500 truncate">Goals: {m.goals.join(', ')}</p>
                  )}
                </div>
                <button type="button" onClick={() => startEdit(m)} className="p-1 text-gray-400 hover:text-gray-600">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => onDelete(m.id)} className="p-1 text-gray-400 hover:text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}

          {showForm && (
            <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
                  <input
                    type="text"
                    placeholder="Aryan"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Relation *</label>
                  <input
                    type="text"
                    placeholder="son, daughter, mother…"
                    value={form.relation}
                    onChange={(e) => setForm((f) => ({ ...f, relation: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date of birth</label>
                  <input
                    type="date"
                    value={form.dob}
                    onChange={(e) => setForm((f) => ({ ...f, dob: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Gender</label>
                  <select
                    value={form.gender}
                    onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Prefer not to say</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="non-binary">Non-binary</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Goals</label>
                <div className="space-y-1 mb-2">
                  {form.goals.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1">
                      <span className="flex-1 text-xs text-gray-700">{g}</span>
                      <button type="button" onClick={() => removeGoalFromForm(i)} className="text-gray-400 hover:text-red-500">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Type a goal and press Enter"
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGoalToForm() } }}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving || !form.name.trim() || !form.relation.trim()}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {!showForm && (
            <button
              type="button"
              onClick={startAdd}
              className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
            >
              + Add family member
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Type-check — expect clean**

```bash
npx tsc --noEmit
```

Expected: zero errors. All section components are now defined.

- [ ] **Step 3: Manual smoke-test**

```bash
npm run dev
```

1. Open `http://localhost:5173`
2. Sign in, navigate to `/profile` (or click the avatar in the nav)
3. Verify all four sections render and collapse
4. Add a location with "Set as default" checked → confirm green badge appears
5. Add a family member with a DOB → confirm age displays correctly
6. Add interests (Enter key) and goals (Enter key) → click Save → reload page → confirm they persist

- [ ] **Step 4: Commit**

```bash
git add src/components/ProfileFamilyMembers.tsx
git commit -m "feat(profile): ProfileFamilyMembers section — full profile feature complete"
```

- [ ] **Step 5: Rebuild MCP after all code is done**

```bash
cd mcp && npm run build && cd ..
git add mcp/dist/
git commit -m "chore(mcp): rebuild dist after profile tools"
```

---

## Self-Review Notes

- `computeAge` is defined in both `mcp/src/index.ts` and `ProfileFamilyMembers.tsx` — intentional duplication; the MCP tool and the UI are independent units.
- `updateLocation` in `profileService.ts` clears all defaults before setting the new one, consistent with the partial unique index constraint.
- `addLocation` in `mcp/src/index.ts` does the same clear-then-set pattern.
- `get_profile_context` omits full addresses (sends only city) — per spec privacy decision.
- All MCP tool names match exactly between the TOOLS array, the switch statement, and the spec.
