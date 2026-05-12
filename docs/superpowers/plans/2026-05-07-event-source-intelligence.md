# Event Source Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal source index — every enrollment URL the user adds gets tagged with up to 10 labels, and Claude queries this index before doing web searches when answering discovery questions.

**Architecture:** Two new Postgres tables (`event_sources`, `event_source_refs`) store domains and tags. Domain extraction happens at event creation time in both the UI path (`eventService.ts`) and the MCP path (`mcp/src/index.ts`). Three MCP tools let Claude save analysis results, retrieve unanalysed sources, and query by tags. CLAUDE.md instructs Claude to analyse new sources immediately after MCP event creation and to call `search_sources` before web search for discovery questions.

**Tech Stack:** TypeScript, Supabase (Postgres + JS client), Vitest (tests), MCP SDK

---

## File map

| File | Change |
|---|---|
| `supabase/migrations/031_event_sources.sql` | Create — two new tables + RLS policies |
| `src/utils/eventSource.ts` | Create — `extractDomain` pure function |
| `tests/utils/eventSource.test.ts` | Create — unit tests for `extractDomain` |
| `src/services/eventService.ts` | Modify — call `upsertEventSource` in `createEvent` and `updateEvent` |
| `mcp/src/index.ts` | Modify — add `extractDomain` helper, three tool functions, TOOLS entries, switch cases; extend `createEvent` to upsert source and return source state |
| `CLAUDE.md` | Modify — add source analysis and discovery query instructions |

---

### Task 1: DB migration — event_sources and event_source_refs

**Files:**
- Create: `supabase/migrations/031_event_sources.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/031_event_sources.sql

CREATE TABLE public.event_sources (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  domain TEXT NOT NULL,
  source_url TEXT NOT NULL,
  name TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  source_type TEXT CHECK (source_type IN ('platform', 'organiser', 'one_off')),
  last_analysed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, domain)
);

CREATE TABLE public.event_source_refs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  event_id UUID REFERENCES public.events(id) ON DELETE CASCADE NOT NULL,
  source_id UUID REFERENCES public.event_sources(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  ref_type TEXT NOT NULL DEFAULT 'enrollment_url',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, source_id)
);

ALTER TABLE public.event_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_source_refs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own sources" ON public.event_sources
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users see own source refs" ON public.event_source_refs
  FOR ALL USING (auth.uid() = user_id);
```

- [ ] **Step 2: Apply the migration locally**

```bash
supabase migration up --include-all
```

Expected: `Applying migration 031_event_sources.sql... done`

- [ ] **Step 3: Verify tables exist**

Run in Supabase Studio SQL editor (`http://127.0.0.1:54323`):

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('event_sources', 'event_source_refs');
```

Expected: 2 rows returned.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/031_event_sources.sql
git commit -m "feat: add event_sources and event_source_refs tables"
```

---

### Task 2: extractDomain utility + unit tests (TDD)

**Files:**
- Create: `src/utils/eventSource.ts`
- Create: `tests/utils/eventSource.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/utils/eventSource.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractDomain } from '../../src/utils/eventSource'

describe('extractDomain', () => {
  it('extracts hostname from a full URL', () => {
    expect(extractDomain('https://www.esdoornkampen.nl/inschrijven')).toBe('esdoornkampen.nl')
  })

  it('strips www. prefix', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com')
  })

  it('leaves non-www subdomains intact', () => {
    expect(extractDomain('https://events.meetup.com/group')).toBe('events.meetup.com')
  })

  it('returns null for an invalid URL', () => {
    expect(extractDomain('not-a-url')).toBeNull()
  })

  it('returns null for localhost', () => {
    expect(extractDomain('http://localhost:3000')).toBeNull()
  })

  it('returns null for IP addresses', () => {
    expect(extractDomain('http://192.168.1.1/page')).toBeNull()
  })

  it('handles URLs without a path', () => {
    expect(extractDomain('https://eventbrite.com')).toBe('eventbrite.com')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:run -- tests/utils/eventSource.test.ts
```

Expected: all 7 tests FAIL with `Cannot find module '../../src/utils/eventSource'`

- [ ] **Step 3: Implement extractDomain**

Create `src/utils/eventSource.ts`:

```ts
export function extractDomain(url: string): string | null {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }
  if (hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null
  return hostname.replace(/^www\./, '')
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:run -- tests/utils/eventSource.test.ts
```

Expected: 7/7 PASS

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/eventSource.ts tests/utils/eventSource.test.ts
git commit -m "feat: add extractDomain utility with unit tests"
```

---

### Task 3: eventService.ts — upsert source on event create and update (UI path)

**Files:**
- Modify: `src/services/eventService.ts`

Context: `eventService.ts` is at `src/services/eventService.ts`. It already imports from `../utils/recurrence`. The `createEvent` function gets the user via `supabase.auth.getUser()` at the top. The `updateEvent` function does not currently fetch the user. Both need to call a local helper that upserts `event_sources` and `event_source_refs`.

- [ ] **Step 1: Add the import for extractDomain**

At the top of `src/services/eventService.ts`, add to the existing imports:

```ts
import { extractDomain } from '../utils/eventSource'
```

- [ ] **Step 2: Add the upsertEventSource helper**

After the existing `import` block (before `insertSessions`), add:

```ts
async function upsertEventSource(userId: string, enrollmentUrl: string, eventId: string): Promise<void> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return
  const { data: source, error } = await supabase
    .from('event_sources')
    .upsert(
      { user_id: userId, domain, source_url: enrollmentUrl },
      { onConflict: 'user_id,domain' }
    )
    .select('id')
    .single()
  if (error || !source) return
  await supabase.from('event_source_refs').upsert(
    { event_id: eventId, source_id: source.id, user_id: userId, ref_type: 'enrollment_url' },
    { onConflict: 'event_id,source_id' }
  )
}
```

- [ ] **Step 3: Call upsertEventSource in createEvent**

In `createEvent`, after the line `if (error) return { data: null, error: new Error(error.message) }` (around line 76), find the block that creates recurring tasks. Add the source upsert call after all the existing `if (event && ...)` blocks, just before `return { data: event, error: null }`:

```ts
  if (event && data.enrollment_url) {
    await upsertEventSource(user.id, data.enrollment_url, event.id)
  }
  return { data: event, error: null }
```

The final lines of `createEvent` should look like:

```ts
  if (event && data.shared_with_group_ids?.length) {
    await setEventSharedWithGroups(event.id, data.shared_with_group_ids)
  }
  if (event && data.enrollment_url) {
    await upsertEventSource(user.id, data.enrollment_url, event.id)
  }
  return { data: event, error: null }
```

- [ ] **Step 4: Call upsertEventSource in updateEvent**

In `updateEvent`, after the line `if (error) return { data: null, error: new Error(error.message) }` (around line 129), add:

```ts
  if (event && data.enrollment_url) {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await upsertEventSource(user.id, data.enrollment_url, id)
  }
```

The block should be inserted after the `setEventSharedWithGroups` call and before `return { data: event, error: null }`:

```ts
  if (event && sharedWithGroupIds !== undefined) {
    await setEventSharedWithGroups(id, sharedWithGroupIds)
  }
  if (event && data.enrollment_url) {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await upsertEventSource(user.id, data.enrollment_url, id)
  }
  return { data: event, error: null }
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/eventService.ts src/utils/eventSource.ts
git commit -m "feat: upsert event source when event is created or updated via UI"
```

---

### Task 4: MCP — add extractDomain helper and three source tools

**Files:**
- Modify: `mcp/src/index.ts`

Context: `mcp/src/index.ts` is a self-contained MCP server. It does not import from `src/`. Add a local `extractDomain` helper (same logic as `src/utils/eventSource.ts`). Then add three tool functions: `updateSource`, `getUnanalysedSources`, `searchSources`. Register them in the `TOOLS` array and the `switch` statement. The pattern to follow is the existing watch task tools (around line 516–668).

- [ ] **Step 1: Add the local extractDomain helper**

Find the comment `// ── Tool implementations ──────────────────────────────────────────────────────` (line 56). Add this helper just above it:

```ts
// ── Utilities ─────────────────────────────────────────────────────────────────

function extractDomain(url: string): string | null {
  let hostname: string
  try { hostname = new URL(url).hostname } catch { return null }
  if (hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null
  return hostname.replace(/^www\./, '')
}
```

- [ ] **Step 2: Add the three source tool functions**

Find the comment `// ── Tool registry ─────────────────────────────────────────────────────────────` (line 670). Add these three functions directly above it:

```ts
// ── Source intelligence tools ─────────────────────────────────────────────────

async function updateSource(args: {
  id: string
  name: string
  tags: string[]
  source_type: 'platform' | 'organiser' | 'one_off'
}) {
  const id = await uid()
  const { data: source, error: fetchErr } = await db
    .from('event_sources')
    .select('id')
    .eq('id', args.id)
    .eq('user_id', id)
    .maybeSingle()
  if (fetchErr) throw new Error(fetchErr.message)
  if (!source) throw new Error('Source not found')
  const { error } = await db
    .from('event_sources')
    .update({
      name: args.name,
      tags: args.tags.slice(0, 10),
      source_type: args.source_type,
      last_analysed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.id)
  if (error) throw new Error(error.message)
  return { success: true }
}

async function getUnanalysedSources() {
  const id = await uid()
  const { data, error } = await db
    .from('event_sources')
    .select('id, domain, source_url')
    .eq('user_id', id)
    .is('last_analysed_at', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

async function searchSources(args: { tags: string[] }) {
  const id = await uid()
  if (!args.tags.length) return []
  const { data, error } = await db
    .from('event_sources')
    .select('id, domain, source_url, name, tags, source_type')
    .eq('user_id', id)
    .overlaps('tags', args.tags)
    .not('last_analysed_at', 'is', null)
  if (error) throw new Error(error.message)
  return data ?? []
}
```

- [ ] **Step 3: Register the three tools in the TOOLS array**

Find the closing `]` of the `TOOLS` array (after the `create_watch_task` tool entry, around line 898). Add before that closing `]`:

```ts
  {
    name: 'update_source',
    description: "Save analysis results for an event source. Call this after fetching the source's homepage and identifying what kinds of events it publishes. Assigns up to 10 tags from activity types (camp, workshop, sailing, climbing, music, sports, hiking, yoga, theatre), audience (kids, adults, family, teens), geography (country/city names), cadence (annual, seasonal, recurring), and format (residential, daytrip, online, weekend).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'event_sources UUID' },
        name: { type: 'string', description: 'Human-readable name of the organiser or platform' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 10 descriptive tags' },
        source_type: { type: 'string', enum: ['platform', 'organiser', 'one_off'], description: 'platform = publishes many events (e.g. Eventbrite); organiser = single entity with recurring events; one_off = single event page' },
      },
      required: ['id', 'name', 'tags', 'source_type'],
    },
  },
  {
    name: 'get_unanalysed_sources',
    description: 'Return all event sources that have never been analysed (last_analysed_at is null). Use when the user asks to analyse their sources, then fetch each source_url and call update_source for each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_sources',
    description: 'Query the personal source library by tag overlap. Call this before doing a web search when the user asks a discovery question (e.g. "find me a sailing course"). Pick relevant tags from the question, call search_sources, fetch the returned URLs directly, then supplement with a web search.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to match against (uses array overlap — any match counts)' },
      },
      required: ['tags'],
    },
  },
```

- [ ] **Step 4: Add switch cases**

In the `switch (name)` block, add after the `create_watch_task` case (line ~932):

```ts
      case 'update_source':          result = await updateSource(args as Parameters<typeof updateSource>[0]); break
      case 'get_unanalysed_sources': result = await getUnanalysedSources(); break
      case 'search_sources':         result = await searchSources(args as Parameters<typeof searchSources>[0]); break
```

- [ ] **Step 5: Build the MCP server**

```bash
cd mcp && npm run build
```

Expected: exits 0, `dist/index.js` updated.

- [ ] **Step 6: Commit**

```bash
cd ..
git add mcp/src/index.ts mcp/dist/
git commit -m "feat: add update_source, get_unanalysed_sources, search_sources MCP tools"
```

---

### Task 5: MCP createEvent — upsert source and return source state

**Files:**
- Modify: `mcp/src/index.ts`

Context: The `createEvent` function in `mcp/src/index.ts` (line 181) currently returns `data` (the raw event row). Extend it to also upsert `event_sources` and `event_source_refs` when `enrollment_url` is present, then return `{...data, source: {id, last_analysed_at} | null}`. Claude reads `source.last_analysed_at` — if null, it fetches the URL and calls `update_source`.

`extractDomain` was added to this file in Task 4.

- [ ] **Step 1: Extend createEvent to upsert source**

Find the end of the `createEvent` function. Currently it ends with `return data` (around line 244). Replace that final block:

**Before:**
```ts
  return data
}
```

**After:**
```ts
  let source: { id: string; last_analysed_at: string | null } | null = null
  if (data && args.enrollment_url) {
    const domain = extractDomain(args.enrollment_url)
    if (domain) {
      const { data: src, error: srcErr } = await db
        .from('event_sources')
        .upsert(
          { user_id: id, domain, source_url: args.enrollment_url },
          { onConflict: 'user_id,domain' }
        )
        .select('id, last_analysed_at')
        .single()
      if (!srcErr && src) {
        await db.from('event_source_refs').upsert(
          { event_id: data.id, source_id: src.id, user_id: id, ref_type: 'enrollment_url' },
          { onConflict: 'event_id,source_id' }
        )
        source = { id: src.id, last_analysed_at: src.last_analysed_at }
      }
    }
  }

  return { ...data, source }
}
```

- [ ] **Step 2: Build the MCP server**

```bash
cd mcp && npm run build
```

Expected: exits 0.

- [ ] **Step 3: Smoke test**

Restart the MCP server. In Claude Code, ask: `Create a test event called "Source Test" with enrollment_url "https://www.esdoornkampen.nl" and start_date "2027-06-01T10:00:00Z".`

Expected response includes `"source": { "id": "...", "last_analysed_at": null }`.

Then check the DB in Supabase Studio:

```sql
SELECT domain, source_url, tags, last_analysed_at FROM event_sources;
```

Expected: one row with `domain = 'esdoornkampen.nl'` and `last_analysed_at = null`.

- [ ] **Step 4: Commit**

```bash
cd ..
git add mcp/src/index.ts mcp/dist/
git commit -m "feat: upsert event source in MCP create_event, return source state"
```

---

### Task 6: CLAUDE.md — source analysis and discovery instructions

**Files:**
- Modify: `CLAUDE.md`

Context: `CLAUDE.md` already has a `## Watch monitoring` section. Add two new sections below it.

- [ ] **Step 1: Add source analysis section**

Append to the end of `CLAUDE.md`:

```markdown
## Source analysis

After calling `create_event` with an `enrollment_url`, the response includes a `source` field.

- If `source` is `null` (no URL or invalid domain): do nothing.
- If `source.last_analysed_at` is `null`: fetch `source_url` using your web fetch capability. Read the page to understand what kinds of events the organiser or platform publishes. Then call `update_source` with:
  - `id`: the source UUID from the response
  - `name`: the organiser or platform name (from page title or about section)
  - `tags`: up to 10 descriptive tags chosen from: activity types (`camp`, `workshop`, `sailing`, `climbing`, `music`, `sports`, `hiking`, `yoga`, `theatre`), audience (`kids`, `adults`, `family`, `teens`), geography (country/city names in lowercase, e.g. `belgium`, `brussels`), cadence (`annual`, `seasonal`, `recurring`), format (`residential`, `daytrip`, `online`, `weekend`). Pick the most discriminating ones.
  - `source_type`: `platform` if the site lists many unrelated events (e.g. Eventbrite, Meetup), `organiser` if it's a single entity with recurring programmes (e.g. a sports club, a school), `one_off` if it's a single event's own page.
- If `source.last_analysed_at` is set: source is already indexed — skip analysis.

The user can also say "analyse my sources" at any time. Call `get_unanalysed_sources`, then for each returned source fetch `source_url` and call `update_source` as above.

## Discovery queries

When the user asks a discovery or search question (e.g. "find me a sailing course for next year", "any summer camps for kids in Belgium?"):

1. Pick 2–4 relevant tags from the question.
2. Call `search_sources` with those tags. If results are returned, fetch each `source_url` to look for matching events.
3. Also run a web search for broader coverage.
4. Combine and present findings, noting which came from known sources vs. web search.
```

- [ ] **Step 2: Verify the file looks correct**

```bash
tail -40 CLAUDE.md
```

Expected: both new sections appear correctly.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "feat: add source analysis and discovery query instructions to CLAUDE.md"
```

---

### Task 7: End-to-end smoke test

No automated test for the full flow — verify manually.

- [ ] **Step 1: Create an event via MCP and verify source is created**

In Claude Code: `Create an event called "Esdoorn Summer Camp" with enrollment_url "https://www.esdoornkampen.nl/zomerkamp" and start_date "2027-07-01T10:00:00Z".`

Expected:
1. Claude creates the event
2. Claude sees `source.last_analysed_at: null` in the response
3. Claude fetches `https://www.esdoornkampen.nl/zomerkamp` (or the homepage)
4. Claude calls `update_source` with appropriate tags (e.g. `["camp", "kids", "belgium", "residential", "summer"]`)
5. Claude confirms analysis in the chat

Verify in Supabase Studio:
```sql
SELECT domain, name, tags, source_type, last_analysed_at FROM event_sources;
```
Expected: tags and name are set, `last_analysed_at` is not null.

- [ ] **Step 2: Verify source ref was created**

```sql
SELECT esr.ref_type, es.domain
FROM event_source_refs esr
JOIN event_sources es ON es.id = esr.source_id;
```

Expected: one row with `ref_type = 'enrollment_url'` and `domain = 'esdoornkampen.nl'`.

- [ ] **Step 3: Test search_sources**

In Claude Code: `Find me summer camps for kids in Belgium.`

Expected:
1. Claude calls `search_sources(["camp", "kids", "belgium"])` (or similar)
2. Claude fetches the returned source URLs
3. Claude supplements with web search
4. Response mentions Esdoorn alongside any web results

- [ ] **Step 4: Test get_unanalysed_sources**

In Claude Code: `Analyse my sources.`

Expected: Claude calls `get_unanalysed_sources`. If all sources are already analysed, Claude says so. If any are unanalysed, Claude fetches and analyses them.

- [ ] **Step 5: Test UI path (EventForm)**

Open the Plannen web app (`http://localhost:5173`). Create an event with an enrollment URL via the form. After saving, check Supabase Studio — the source row should be created with `last_analysed_at = null` (UI path doesn't analyse; Claude does that later).
