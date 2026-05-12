# Save Sources (Bookmarks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user bookmark a source (organiser / platform / one-off page) mid-conversation via a new `save_source` MCP tool, with agent-side rules for when to call it (explicit, positive-intent, end-of-discovery).

**Architecture:** New MCP tool wrapping a refactored `upsertSource` helper (made event-optional) + analysis UPDATE — same sequential pattern as today's `update_source`. Validation lives in a new `mcp/src/sources.ts` module so it's unit-testable without Supabase. Plugin rules live in `plannen-core.md`; no schema changes; no edge functions.

**Tech Stack:** TypeScript (MCP server), Supabase JS client, Vitest, Markdown (plugin skills).

**Spec:** `docs/superpowers/specs/2026-05-12-save-sources-design.md`

---

## Task 1: Validation helpers in `mcp/src/sources.ts`

Pure functions that parse and validate `save_source` inputs. Extracted so they're unit-testable without a Supabase client.

**Files:**
- Create: `mcp/src/sources.ts`
- Test: `mcp/src/sources.test.ts`

- [ ] **Step 1: Write failing tests**

Create `mcp/src/sources.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseSourceUrl,
  normaliseTags,
  validateName,
  validateSourceType,
} from './sources.js'

describe('parseSourceUrl', () => {
  it('extracts domain and strips www.', () => {
    expect(parseSourceUrl('https://www.pauseandplay.be/')).toEqual({
      domain: 'pauseandplay.be',
      sourceUrl: 'https://www.pauseandplay.be/',
    })
  })
  it('preserves non-www host', () => {
    expect(parseSourceUrl('https://app.twizzit.com/foo')).toEqual({
      domain: 'app.twizzit.com',
      sourceUrl: 'https://app.twizzit.com/foo',
    })
  })
  it('throws "invalid url" for non-URL strings', () => {
    expect(() => parseSourceUrl('not a url')).toThrow('invalid url')
  })
  it('throws "invalid url" for non-http protocols', () => {
    expect(() => parseSourceUrl('ftp://example.com')).toThrow('invalid url')
  })
  it('throws "invalid url" for empty string', () => {
    expect(() => parseSourceUrl('')).toThrow('invalid url')
  })
})

describe('normaliseTags', () => {
  it('trims, lowercases, dedupes', () => {
    expect(normaliseTags(['  Kids ', 'kids', 'BRUNCH'])).toEqual(['kids', 'brunch'])
  })
  it('caps at 10', () => {
    const input = Array.from({ length: 15 }, (_, i) => `tag${i}`)
    expect(normaliseTags(input)).toHaveLength(10)
  })
  it('drops empty / whitespace-only entries', () => {
    expect(normaliseTags(['kids', '   ', ''])).toEqual(['kids'])
  })
  it('throws "tags required" for empty array', () => {
    expect(() => normaliseTags([])).toThrow('tags required')
  })
  it('throws "tags required" when all entries are whitespace', () => {
    expect(() => normaliseTags(['  ', ''])).toThrow('tags required')
  })
})

describe('validateName', () => {
  it('returns trimmed name', () => {
    expect(validateName('  Pause & Play  ')).toBe('Pause & Play')
  })
  it('throws "name required" for empty string', () => {
    expect(() => validateName('')).toThrow('name required')
  })
  it('throws "name required" for whitespace-only', () => {
    expect(() => validateName('   ')).toThrow('name required')
  })
})

describe('validateSourceType', () => {
  it('accepts platform, organiser, one_off', () => {
    expect(validateSourceType('platform')).toBe('platform')
    expect(validateSourceType('organiser')).toBe('organiser')
    expect(validateSourceType('one_off')).toBe('one_off')
  })
  it('throws "invalid source_type" for other values', () => {
    expect(() => validateSourceType('venue')).toThrow('invalid source_type')
    expect(() => validateSourceType('')).toThrow('invalid source_type')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm test -- sources.test.ts`
Expected: FAIL — `Cannot find module './sources.js'` (or similar import error).

- [ ] **Step 3: Implement `mcp/src/sources.ts`**

```ts
// Pure validation helpers for the save_source MCP tool.
// Kept dependency-free so they can be unit-tested without Supabase.

export type SourceType = 'platform' | 'organiser' | 'one_off'

const VALID_SOURCE_TYPES: readonly SourceType[] = ['platform', 'organiser', 'one_off']

export function parseSourceUrl(input: string): { domain: string; sourceUrl: string } {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('invalid url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid url')
  }
  const domain = url.host.replace(/^www\./, '')
  return { domain, sourceUrl: input }
}

export function normaliseTags(input: string[]): string[] {
  const cleaned = input
    .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter((t) => t.length > 0)
  const deduped = Array.from(new Set(cleaned))
  if (deduped.length === 0) throw new Error('tags required')
  return deduped.slice(0, 10)
}

export function validateName(input: string): string {
  if (typeof input !== 'string') throw new Error('name required')
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error('name required')
  return trimmed
}

export function validateSourceType(input: string): SourceType {
  if (!VALID_SOURCE_TYPES.includes(input as SourceType)) {
    throw new Error('invalid source_type')
  }
  return input as SourceType
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm test -- sources.test.ts`
Expected: All 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/sources.ts mcp/src/sources.test.ts
git commit -m "mcp: add source input validation helpers"
```

---

## Task 2: Refactor `upsertSource` to make `eventId` nullable

Today `upsertSource` always inserts an `event_source_refs` row. For standalone bookmarks there's no event yet, so the parameter must become nullable and the ref insert conditional.

**Files:**
- Modify: `mcp/src/index.ts:187-208` (the `upsertSource` function), and callers at `mcp/src/index.ts:275` and `mcp/src/index.ts:305` (in `createEvent` / `updateEvent`).

- [ ] **Step 1: Change the function signature and body**

Replace lines 187–208 with:

```ts
async function upsertSource(
  userId: string,
  eventId: string | null,
  enrollmentUrl: string
): Promise<{ id: string; last_analysed_at: string | null } | null> {
  const domain = extractDomain(enrollmentUrl)
  if (!domain) return null
  const { data: src, error: srcErr } = await db
    .from('event_sources')
    .upsert(
      { user_id: userId, domain, source_url: enrollmentUrl },
      { onConflict: 'user_id,domain' }
    )
    .select('id, last_analysed_at')
    .single()
  if (srcErr || !src) return null
  if (eventId) {
    await db.from('event_source_refs').upsert(
      { event_id: eventId, source_id: src.id, user_id: userId, ref_type: 'enrollment_url' },
      { onConflict: 'event_id,source_id' }
    )
  }
  return { id: src.id, last_analysed_at: src.last_analysed_at }
}
```

Only changes: parameter type `string` → `string | null`, and the `event_source_refs` upsert wrapped in `if (eventId)`. Existing callers at lines 275 and 305 pass a real `data.id` / `args.id`, so they continue to work unchanged.

- [ ] **Step 2: Build to verify TypeScript compiles**

Run: `cd mcp && npm run build`
Expected: build succeeds with no TS errors.

- [ ] **Step 3: Run existing tests to verify nothing regressed**

Run: `cd mcp && npm test`
Expected: All previously passing tests still pass (profileFacts, recurrence, transcribe, sources).

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "mcp: make upsertSource eventId nullable"
```

---

## Task 3: Add `saveSource` handler in `mcp/src/index.ts`

The new handler that wires validation helpers to `upsertSource` and writes analysis fields.

**Files:**
- Modify: `mcp/src/index.ts` — add import for sources.ts helpers near other imports; add `saveSource` async function near other source handlers (after `updateSource` around line 1237).

- [ ] **Step 1: Add the import**

Find the existing imports at the top of `mcp/src/index.ts`. Add this line alongside other relative imports:

```ts
import { parseSourceUrl, normaliseTags, validateName, validateSourceType } from './sources.js'
```

- [ ] **Step 2: Add the `saveSource` function**

Insert after the existing `updateSource` function (the one ending around line 1237). Place this just before `getUnanalysedSources`:

```ts
async function saveSource(args: {
  url: string
  name: string
  tags: string[]
  source_type: string
}) {
  const { domain, sourceUrl } = parseSourceUrl(args.url)
  const name = validateName(args.name)
  const tags = normaliseTags(args.tags)
  const source_type = validateSourceType(args.source_type)

  const userId = await uid()

  // Detect whether the row pre-existed (for accurate action reporting).
  const { data: pre } = await db
    .from('event_sources')
    .select('id')
    .eq('user_id', userId)
    .eq('domain', domain)
    .maybeSingle()
  const action: 'inserted' | 'updated' = pre ? 'updated' : 'inserted'

  const upserted = await upsertSource(userId, null, sourceUrl)
  if (!upserted) throw new Error('failed to upsert source')

  const { error } = await db
    .from('event_sources')
    .update({
      name,
      tags,
      source_type,
      last_analysed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', upserted.id)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)

  return { id: upserted.id, domain, action }
}
```

- [ ] **Step 3: Build to verify TypeScript compiles**

Run: `cd mcp && npm run build`
Expected: build succeeds with no TS errors.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "mcp: add saveSource handler"
```

---

## Task 4: Register `save_source` in the tool list and switch case

Expose the handler over MCP.

**Files:**
- Modify: `mcp/src/index.ts` — the `TOOLS` array (currently ending around line 1854) and the `switch (name)` block (around line 1900).

- [ ] **Step 1: Add the tool descriptor to the `TOOLS` array**

Insert this entry immediately **before** the existing `update_source` entry (currently around line 1777):

```ts
  {
    name: 'save_source',
    description: "Save a source (organiser, platform, or one-off page) as a standalone bookmark — without creating an event. Call this when the user explicitly asks to save/bookmark a link, says a specific link looks good (\"X looks good\", \"send X to whatsapp\"), or accepts the end-of-discovery batch ask. The agent must have the page content first (from WebFetch) so name/tags/source_type can be derived. Tags follow the same vocabulary as update_source — lead with the specific activity. Returns action: 'inserted' for a new bookmark, 'updated' when refreshing an existing one.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) source URL' },
        name: { type: 'string', description: 'Human-readable organiser/platform name' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 10 descriptive tags (activity first, then audience, geography, cadence, format)' },
        source_type: { type: 'string', enum: ['platform', 'organiser', 'one_off'], description: 'platform = publishes many events; organiser = single entity with recurring events; one_off = single event page' },
      },
      required: ['url', 'name', 'tags', 'source_type'],
    },
  },
```

- [ ] **Step 2: Add the switch case**

In the `switch (name)` block (around line 1900), add this case immediately above the existing `case 'update_source':` line:

```ts
      case 'save_source':            result = await saveSource(args as Parameters<typeof saveSource>[0]); break
```

- [ ] **Step 3: Build to verify TypeScript compiles**

Run: `cd mcp && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Verify the tool is discoverable via the built server**

Run from the project root:
```bash
cd mcp && node -e "import('./dist/index.js').catch(()=>{}); setTimeout(()=>process.exit(0), 500)"
```
(This is just a smoke check that the file loads without runtime errors. The MCP server needs stdin to actually serve, so we don't try to call tools here.)

Better verification — grep the built output to confirm the tool name landed:
```bash
grep -c "save_source" mcp/dist/index.js
```
Expected: ≥ 2 (at least the tool entry + the switch case).

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts
git commit -m "mcp: register save_source tool"
```

---

## Task 5: Plugin rules in `plannen-core.md`

Document when the agent should call `save_source`.

**Files:**
- Modify: `plugin/skills/plannen-core.md` — add a new "Saving sources (bookmarks)" section after the existing "Source analysis (auto-trigger)" section.

- [ ] **Step 1: Locate the insertion point**

Open `plugin/skills/plannen-core.md` and find the end of the "Source analysis (auto-trigger)" section (the one that ends with the line about `/plannen-sources` for the manual path).

- [ ] **Step 2: Insert the new section**

Immediately after that closing line, add:

```markdown
## Saving sources (bookmarks)

Use the `save_source` MCP tool to bookmark an organiser, platform, or one-off page **without** creating an event. The tool requires `url`, `name`, `tags`, and `source_type` — same vocabulary as `update_source`. The agent must already have the page content (via WebFetch in this turn or earlier in the conversation) so it can derive name/tags/source_type before the call.

Three trigger paths:

### Rule 1 — Explicit user request

Phrases like *"save this as a source"*, *"bookmark it"*, *"bookmark this"*, *"save the link"*, *"add it to my sources"* → call `save_source` immediately with no confirmation prompt.

If page content isn't already in context, WebFetch the URL first, derive name/tags/source_type, then save.

Confirmation line after success: *"Saved <name> as a source."* for `action: "inserted"`, or *"Refreshed tags on <name>."* for `action: "updated"`.

### Rule 2 — Positive-intent toward a specific link

When the user singles out **one** link from a previously presented shortlist with positive sentiment — *"X looks good"*, *"let's go with X"*, *"send X to whatsapp"*, *"share X with Nimisha"*, *"let's look at X"*, *"check X out"* — end the reply with exactly one line:

> *"Want me to save <name> as a source so it shows up in future searches?"*

On an affirmative reply, call `save_source`. Don't ask again in the same turn for other links.

### Rule 3 — End-of-discovery batch ask

After any discovery turn that presented **≥2 candidate links** and the user did **not** single one out (Rule 2 didn't fire), end the reply with exactly one line:

> *"Want me to save any of these as sources for next time? (reply with names, or 'all', or skip)"*

Responses:
- Specific names → save those (one `save_source` call per name).
- *"all"* / *"yes all"* → save the entire shortlist (one `save_source` call per item).
- User ignores or changes topic → drop it; never re-ask.

Each save is a separate tool call, so partial failure is natural: if one throws, skip it and continue the others; surface the failed names in one trailing line at the end (*"Couldn't save X — its page didn't fetch cleanly."*).

### Suppression rules

- **Already saved**: don't ask if `search_sources` returned a hit for the domain during this turn.
- **No double-asking**: Rule 2 and Rule 3 are mutually exclusive in a single reply — if Rule 2 fired, suppress Rule 3.
- **One prompt per turn**: at most one save-prompt line in any assistant response.
- **Two-strike suppression**: if the user has declined a save-prompt twice consecutively in the same session, suppress for the rest of the session.

### Wording principles

- Always name the specific source(s) — never *"want me to save these?"* on its own.
- One line, at the very end of the reply, after any intent-gate question that's already there.
- Never apologise for asking; never explain the mechanism unless asked.

### Error mapping

The tool throws `Error` with these messages (top-level handler converts to `isError: true`):

- `"invalid url"` → *"That URL doesn't look valid — can you paste the full link?"*
- `"name required"`, `"tags required"`, `"invalid source_type"` → agent's own bug. Retry once after deriving missing fields; if it fails again, surface *"Couldn't tag this — try `/plannen-sources` later."*
- Supabase error string → *"Couldn't reach the local DB — is Supabase running?"*
```

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/plannen-core.md
git commit -m "plugin: document save_source trigger rules in plannen-core"
```

---

## Task 6: Cross-reference in `plannen-sources.md`

One-line pointer so users (and future agents) reading the bulk-analyse skill know about the single-save path.

**Files:**
- Modify: `plugin/skills/plannen-sources.md` — add a one-line note near the top.

- [ ] **Step 1: Add the cross-reference**

Open `plugin/skills/plannen-sources.md`. After the existing frontmatter / opening description (i.e. just before the first concrete instruction in the body), insert one line:

```markdown
> For single-link saves mid-conversation (explicit, positive-intent, or end-of-discovery batch), see the "Saving sources (bookmarks)" section in `plannen-core.md`. This skill is the *bulk-analyse* manual path.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/skills/plannen-sources.md
git commit -m "plugin: cross-reference save_source from plannen-sources"
```

---

## Task 7: Manual integration walkthrough

Verify the end-to-end flow against the real local MCP. Three scripted scenarios from the spec, executed by hand. This is the only place where we test the trigger heuristics live, because they're prose rules in a plugin, not unit-testable code.

**Files:** none modified; this is a verification step.

- [ ] **Step 1: Rebuild and restart the MCP**

```bash
cd mcp && npm run build
```

Restart Claude Code / Claude Desktop so it reloads the rebuilt MCP server (or run `/plannen-doctor` to confirm it's up).

- [ ] **Step 2: Snapshot the current sources for comparison**

In a fresh Claude conversation:

> "List all my saved sources by name and domain."

Save the output — this is the baseline.

- [ ] **Step 3: Scenario A — explicit save**

In a fresh Claude conversation:

> "Save https://www.pauseandplay.be/ as a source."

Expected behaviour:
1. Claude fetches the page (or uses already-cached content).
2. Claude calls `save_source` with `url`, derived `name` ("Pause & Play" or similar), derived `tags` (lead with activity/audience), `source_type: "organiser"`.
3. Reply contains exactly one confirmation line: *"Saved Pause & Play as a source."* (or `"Refreshed tags on …"` if already present).
4. **Verify analysis fields wrote through:** `search_sources(["brunch"])` returns this row with the expected tags.
5. **Verify no event_source_refs row was created** for this save. Run against the local DB:

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
  "SELECT count(*) FROM event_source_refs r JOIN event_sources s ON s.id = r.source_id WHERE s.domain = 'pauseandplay.be';"
```

Expected: count is 0 (no event linked this source yet). If non-zero, the `upsertSource` nullable-eventId refactor in Task 2 is wrong — investigate.

- [ ] **Step 4: Scenario B — positive-intent single-link**

In a fresh Claude conversation:

> "Find me a kid-friendly brunch spot in Antwerp."

After Claude presents a shortlist of ≥2 places:

> "Zelda & Zorro looks good, send it to whatsapp."

Expected behaviour:
1. Claude sends the WhatsApp message (existing tool).
2. Claude ends the reply with exactly one line: *"Want me to save Zelda & Zorro as a source so it shows up in future searches?"*
3. Reply: *"yes"*.
4. Claude calls `save_source` and confirms in one line.
5. **Verify:** the new row appears in a fresh `search_sources(["brunch", "antwerp"])`.

- [ ] **Step 5: Scenario C — end-of-discovery batch**

In a fresh Claude conversation:

> "Any kayaking spots near Mechelen besides the one I'm already going to?"

After Claude presents a shortlist of ≥2 places:

Expected: the reply ends with exactly one line: *"Want me to save any of these as sources for next time? (reply with names, or 'all', or skip)"*

Reply: *"save the first two"*.

Expected behaviour: two `save_source` calls; final reply confirms in one line which two were saved.

- [ ] **Step 6: Negative check — already-saved suppression**

Repeat Scenario A's prompt verbatim. Expected: Claude detects the source is already saved (via `search_sources`) and either skips the save or surfaces *"Refreshed tags on Pause & Play."* No double-saved row.

- [ ] **Step 7: Negative check — Rule 3 does not fire after Rule 2**

Repeat Scenario B but in step 4 say *"no thanks"*. The next message in the conversation should NOT contain another save-prompt — Rule 2 fired and was declined; suppression applies.

- [ ] **Step 8: Document walkthrough results**

If all 7 steps pass cleanly: no further action.

If any step fails: open `docs/superpowers/specs/2026-05-12-save-sources-design.md` and append an "Implementation deviations" section describing what differs and why. Commit that with `docs: note save_source implementation deviations`.

---

## Done

After Task 7, the feature is complete. Summary of the diff:

- `mcp/src/sources.ts` (new) + `mcp/src/sources.test.ts` (new) — 14 unit tests
- `mcp/src/index.ts` — `upsertSource` signature change (nullable `eventId`), new `saveSource` handler, new tool entry + switch case
- `plugin/skills/plannen-core.md` — new "Saving sources (bookmarks)" section
- `plugin/skills/plannen-sources.md` — one-line cross-reference

No DB migration. No edge function. No web UI.
