# User Profile — Design Spec
_Date: 2026-05-05 · Branch: feat/plannen-tier-1_

---

## Problem

Plannen's AI discovery currently knows nothing about the user. When you type "swimming classes for my son near home", it has no idea who "my son" is or where "home" means. Profile data gives Claude the semantic context to resolve these references naturally — no buttons, no filters.

---

## Scope (tier-1 only)

This spec covers the tier-1 (Claude Desktop / Claude Code) implementation. The `agent-discover` edge function is **not** updated in this feature; that is a future tier-4 concern.

---

## What gets built

### 1. Three new database tables

**`user_profiles`** — 1-to-1 with `users`, created on first save.

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID PK FK → users.id | |
| `dob` | DATE | nullable |
| `goals` | TEXT[] | free-text personal goals |
| `interests` | TEXT[] | free-text interest tags |

**`user_locations`** — 1-to-many.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users.id | |
| `label` | TEXT | e.g. "Home", "Work" |
| `address` | TEXT | full address string |
| `city` | TEXT | |
| `country` | TEXT | |
| `is_default` | BOOLEAN | used when no location specified in query; at most one default per user (enforced via partial unique index) |

**`family_members`** — offline people (not Plannen users), 1-to-many.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `user_id` | UUID FK → users.id | |
| `name` | TEXT NOT NULL | |
| `relation` | TEXT NOT NULL | e.g. "son", "daughter", "mother" |
| `dob` | DATE | nullable; age computed at query time |
| `gender` | TEXT | nullable |
| `goals` | TEXT[] | nullable |

**Privacy:** all three tables have RLS policy `auth.uid() = user_id`. Strictly private — no sharing policies.

**Unchanged:** `users` table and `relationships` table stay as-is. Plannen-to-Plannen family/friend connections are unaffected.

---

### 2. Profile UI — `/profile` page

Accessed via avatar dropdown → "My Profile" in the top nav. Four collapsible sections:

| Section | Fields |
|---------|--------|
| Personal Info | Full name (existing), date of birth |
| My Locations | Label, address, city, country, default flag. Add / edit / delete. |
| Interests & Goals | Interests: pill tags (type to add, click to remove). Goals: list entries (type to add, click to remove). |
| Family Members | Cards showing name, relation, computed age, goals summary. Add / edit / delete. |

"Save Profile" button at the bottom. All saves go to the three tables above via the existing Supabase client.

---

### 3. MCP tools (tier-1 interface)

Six new tools added to `mcp/` alongside existing tools. All are pure data — no AI calls, consistent with the existing MCP design principle.

| Tool | What it does |
|------|-------------|
| `get_profile_context` | Returns compact profile JSON for Claude to reason over: locations (label + city only, not full address), interests, goals, family members with **computed ages** (not raw DOBs) |
| `update_profile` | Save DOB, goals[], interests[] to `user_profiles` (upsert) |
| `add_family_member` | Add an offline family member |
| `list_family_members` | List all family members with computed ages |
| `add_location` | Add a named location; optionally set as default |
| `list_locations` | List saved locations |

**`get_profile_context` output shape:**
```json
{
  "locations": [
    { "label": "Home", "city": "Antwerp", "is_default": true },
    { "label": "Work", "city": "Brussels" }
  ],
  "interests": ["yoga", "cooking", "trail running"],
  "goals": ["learn to swim", "run a half marathon"],
  "family_members": [
    { "name": "Aryan", "relation": "son", "age": 5, "gender": "male",
      "goals": ["learn to swim"] }
  ]
}
```

Age is computed as `floor((today - dob) / 365.25)`. Full addresses are never included in this output — only city — to minimise sensitive data in Claude's context.

**Graceful degradation:** if the user has no profile data, `get_profile_context` returns an empty object `{}`. Claude falls back to asking the user directly. No errors.

---

### 4. How it works end-to-end (tier-1)

```
User → Claude Desktop / Claude Code
  "swimming classes for my son near home this weekend"

Claude calls: get_profile_context
  ← { family_members: [{ name: "Aryan", relation: "son", age: 5 }],
       locations: [{ label: "Home", city: "Antwerp", is_default: true }] }

Claude resolves:
  "my son" → Aryan, 5 years old
  "near home" → Antwerp

Claude uses built-in web search:
  → age-appropriate swimming classes in Antwerp this weekend

User picks a result → Claude calls: create_event (existing tool)
```

No Anthropic API key configuration needed. No edge functions. Claude's own subscription handles the AI and web search.

---

## Out of scope

- Updating `agent-discover` edge function to use profile context (tier-4 concern)
- Profile data visible to friends/family (all data is strictly private)
- Predefined interest/goal categories (free-text only)
- Profile photo beyond the existing `avatar_url` on `users`
- Editing offline family members' Plannen relationship records (separate concept)

---

## Open questions

_None — all design decisions resolved during brainstorming._
