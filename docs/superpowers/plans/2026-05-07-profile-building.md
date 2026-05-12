# Profile Building Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an incremental profile knowledge graph — a `profile_facts` table with confidence scoring — and four MCP tools that let Claude silently learn and update facts about the user and their family during natural conversation.

**Architecture:** A new `profile_facts` table stores facts as subject/predicate/value triples with confidence (0.0–1.0), temporal metadata, and a historical flag. Four MCP tools handle upsert (with confidence arithmetic), correction, listing current facts, and listing historical facts. `get_profile_context` is extended to include current facts. CLAUDE.md and the plannen skill gain a profile-building instruction block.

**Tech Stack:** TypeScript, Supabase (PostgreSQL + RLS), MCP SDK, Vitest (added to mcp/ for unit testing confidence logic)

---

### Task 1: Database migration — `profile_facts` table

**Files:**
- Create: `supabase/migrations/032_profile_facts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/032_profile_facts.sql

CREATE TABLE public.profile_facts (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,  -- "user" or a family_members.id UUID
  predicate      TEXT NOT NULL,  -- e.g. "likes", "goes_to_school_at", "allergic_to"
  value          TEXT NOT NULL,
  confidence     FLOAT NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  observed_count INT NOT NULL DEFAULT 1,
  source         TEXT NOT NULL CHECK (source IN ('agent_inferred', 'user_stated')),
  is_historical  BOOLEAN NOT NULL DEFAULT false,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_profile_facts_user_id ON public.profile_facts (user_id);
CREATE INDEX idx_profile_facts_subject ON public.profile_facts (user_id, subject);
CREATE INDEX idx_profile_facts_lookup  ON public.profile_facts (user_id, subject, predicate, is_historical);

ALTER TABLE public.profile_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profile_facts: owner only"
  ON public.profile_facts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

- [ ] **Step 2: Apply the migration**

```bash
cd /Users/stroomnova/Music/plannen
supabase db reset
```

Expected: migration runs without errors, `profile_facts` table exists.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/032_profile_facts.sql
git commit -m "feat: add profile_facts table for knowledge graph"
```

---

### Task 2: Confidence logic as pure functions (with tests)

**Files:**
- Create: `mcp/src/profileFacts.ts`
- Create: `mcp/src/profileFacts.test.ts`
- Modify: `mcp/package.json`

The confidence arithmetic is the core of this feature — isolate it so it can be tested without Supabase.

- [ ] **Step 1: Add Vitest to mcp/package.json**

Replace `mcp/package.json` with:

```json
{
  "name": "plannen-mcp",
  "version": "1.0.0",
  "description": "MCP server for Plannen — lets Claude Desktop and Claude Code interact with your local Plannen instance",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@supabase/supabase-js": "^2.49.4"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "tsx": "^4.19.3",
    "typescript": "^5.8.3",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Install vitest**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm install
```

Expected: vitest added to node_modules.

- [ ] **Step 3: Write the failing tests**

Create `mcp/src/profileFacts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  computeCorroborationConfidence,
  computeContradictionConfidence,
  shouldMarkHistorical,
  initialConfidence,
} from './profileFacts.js'

describe('initialConfidence', () => {
  it('returns 0.7 for agent_inferred', () => {
    expect(initialConfidence('agent_inferred')).toBe(0.7)
  })
  it('returns 1.0 for user_stated', () => {
    expect(initialConfidence('user_stated')).toBe(1.0)
  })
})

describe('computeCorroborationConfidence', () => {
  it('increases confidence by 0.1', () => {
    expect(computeCorroborationConfidence(0.7)).toBeCloseTo(0.8)
  })
  it('caps at 1.0', () => {
    expect(computeCorroborationConfidence(0.95)).toBe(1.0)
  })
  it('caps at 1.0 when already at 1.0', () => {
    expect(computeCorroborationConfidence(1.0)).toBe(1.0)
  })
})

describe('computeContradictionConfidence', () => {
  it('decreases confidence by 0.3', () => {
    expect(computeContradictionConfidence(0.7)).toBeCloseTo(0.4)
  })
  it('floors at 0.0', () => {
    expect(computeContradictionConfidence(0.2)).toBe(0.0)
  })
})

describe('shouldMarkHistorical', () => {
  it('returns true when confidence < 0.4', () => {
    expect(shouldMarkHistorical(0.39)).toBe(true)
  })
  it('returns false when confidence >= 0.4', () => {
    expect(shouldMarkHistorical(0.4)).toBe(false)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm test
```

Expected: FAIL — `profileFacts.js` not found.

- [ ] **Step 5: Create `mcp/src/profileFacts.ts`**

```typescript
export type FactSource = 'agent_inferred' | 'user_stated'

export function initialConfidence(source: FactSource): number {
  return source === 'user_stated' ? 1.0 : 0.7
}

export function computeCorroborationConfidence(current: number): number {
  return Math.min(1.0, current + 0.1)
}

export function computeContradictionConfidence(current: number): number {
  return Math.max(0.0, current - 0.3)
}

export function shouldMarkHistorical(confidence: number): boolean {
  return confidence < 0.4
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm test
```

Expected: All 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp/package.json mcp/package-lock.json mcp/src/profileFacts.ts mcp/src/profileFacts.test.ts
git commit -m "feat: add profile fact confidence logic with tests"
```

---

### Task 3: `upsert_profile_fact` MCP tool

**Files:**
- Modify: `mcp/src/index.ts`

This tool handles all three cases: new fact, corroboration, and contradiction.

- [ ] **Step 1: Add the function after `getProfileContext` in `mcp/src/index.ts`**

Add after line ~472 (after `getProfileContext`):

```typescript
async function upsertProfileFact(args: {
  subject: string
  predicate: string
  value: string
  source: FactSource
}) {
  const id = await uid()

  const { data: existing } = await db
    .from('profile_facts')
    .select('id, value, confidence, observed_count')
    .eq('user_id', id)
    .eq('subject', args.subject)
    .eq('predicate', args.predicate)
    .eq('is_historical', false)
    .maybeSingle()

  if (!existing) {
    const { error } = await db.from('profile_facts').insert({
      user_id: id,
      subject: args.subject,
      predicate: args.predicate,
      value: args.value,
      confidence: initialConfidence(args.source),
      observed_count: 1,
      source: args.source,
    })
    if (error) throw new Error(error.message)
    return { action: 'inserted' }
  }

  if (existing.value === args.value) {
    const newConfidence = computeCorroborationConfidence(existing.confidence)
    const { error } = await db
      .from('profile_facts')
      .update({ confidence: newConfidence, observed_count: existing.observed_count + 1, last_seen_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
    return { action: 'corroborated', confidence: newConfidence }
  }

  // Contradiction
  const decayedConfidence = computeContradictionConfidence(existing.confidence)
  const { error: decayErr } = await db
    .from('profile_facts')
    .update({ confidence: decayedConfidence, is_historical: shouldMarkHistorical(decayedConfidence) })
    .eq('id', existing.id)
  if (decayErr) throw new Error(decayErr.message)

  const { error: insertErr } = await db.from('profile_facts').insert({
    user_id: id,
    subject: args.subject,
    predicate: args.predicate,
    value: args.value,
    confidence: initialConfidence(args.source),
    observed_count: 1,
    source: args.source,
  })
  if (insertErr) throw new Error(insertErr.message)
  return { action: 'contradicted', old_value: existing.value, new_value: args.value }
}
```

- [ ] **Step 2: Add the import at the top of `mcp/src/index.ts`** (after existing imports)

```typescript
import {
  initialConfidence,
  computeCorroborationConfidence,
  computeContradictionConfidence,
  shouldMarkHistorical,
  type FactSource,
} from './profileFacts.js'
```

- [ ] **Step 3: Register the tool schema** — add to the tools array (after the `get_profile_context` tool entry):

```typescript
  {
    name: 'upsert_profile_fact',
    description: 'Add a new profile fact or update an existing one. Handles corroboration and contradiction with confidence scoring. Use this silently during conversation when you detect a new or corroborating fact about the user or a family member.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_member UUID' },
        predicate: { type: 'string', description: 'The fact type, e.g. "likes", "goes_to_school_at", "allergic_to", "prefers_time_of_day"' },
        value: { type: 'string', description: 'The fact value' },
        source: { type: 'string', enum: ['agent_inferred', 'user_stated'], description: 'agent_inferred for things Claude noticed; user_stated for things the user explicitly said' },
      },
      required: ['subject', 'predicate', 'value', 'source'],
    },
  },
```

- [ ] **Step 4: Wire up the case handler** — add to the switch statement in the tool call handler:

```typescript
case 'upsert_profile_fact': result = await upsertProfileFact(args as Parameters<typeof upsertProfileFact>[0]); break
```

- [ ] **Step 5: Build and verify no TypeScript errors**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm run build
```

Expected: clean build, no errors.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/index.ts mcp/src/profileFacts.ts
git commit -m "feat: add upsert_profile_fact MCP tool"
```

---

### Task 4: `correct_profile_fact` MCP tool

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add the function** (after `upsertProfileFact`):

```typescript
async function correctProfileFact(args: {
  subject: string
  predicate: string
  old_value: string
  new_value: string
}) {
  const id = await uid()

  // Mark old fact as historical
  const { error: histErr } = await db
    .from('profile_facts')
    .update({ is_historical: true, confidence: 0.0 })
    .eq('user_id', id)
    .eq('subject', args.subject)
    .eq('predicate', args.predicate)
    .eq('value', args.old_value)
    .eq('is_historical', false)
  if (histErr) throw new Error(histErr.message)

  // Insert corrected fact at full confidence
  const { error: insertErr } = await db.from('profile_facts').insert({
    user_id: id,
    subject: args.subject,
    predicate: args.predicate,
    value: args.new_value,
    confidence: 1.0,
    observed_count: 1,
    source: 'user_stated' as FactSource,
  })
  if (insertErr) throw new Error(insertErr.message)
  return { corrected: true, predicate: args.predicate, old_value: args.old_value, new_value: args.new_value }
}
```

- [ ] **Step 2: Register tool schema** (add to tools array):

```typescript
  {
    name: 'correct_profile_fact',
    description: 'Correct a wrong profile fact. Marks the old value as historical and saves the corrected value at full confidence. Use when the user says something contradicts what was previously saved.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_member UUID' },
        predicate: { type: 'string', description: 'The fact type, e.g. "goes_to_school_at"' },
        old_value: { type: 'string', description: 'The previously saved (wrong) value' },
        new_value: { type: 'string', description: 'The corrected value' },
      },
      required: ['subject', 'predicate', 'old_value', 'new_value'],
    },
  },
```

- [ ] **Step 3: Wire up case handler**:

```typescript
case 'correct_profile_fact': result = await correctProfileFact(args as Parameters<typeof correctProfileFact>[0]); break
```

- [ ] **Step 4: Build**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat: add correct_profile_fact MCP tool"
```

---

### Task 5: `list_profile_facts` and `get_historical_facts` MCP tools

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add `listProfileFacts` function** (after `correctProfileFact`):

```typescript
async function listProfileFacts(args: { subject?: string }) {
  const id = await uid()
  let q = db
    .from('profile_facts')
    .select('id, subject, predicate, value, confidence, observed_count, source, first_seen_at, last_seen_at')
    .eq('user_id', id)
    .eq('is_historical', false)
    .gte('confidence', 0.6)
    .order('subject')
    .order('confidence', { ascending: false })
  if (args.subject) q = q.eq('subject', args.subject)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}
```

- [ ] **Step 2: Add `getHistoricalFacts` function**:

```typescript
async function getHistoricalFacts(args: { subject?: string }) {
  const id = await uid()
  let q = db
    .from('profile_facts')
    .select('id, subject, predicate, value, confidence, source, first_seen_at, last_seen_at')
    .eq('user_id', id)
    .eq('is_historical', true)
    .order('subject')
    .order('last_seen_at', { ascending: false })
  if (args.subject) q = q.eq('subject', args.subject)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}
```

- [ ] **Step 3: Register both tool schemas** (add to tools array):

```typescript
  {
    name: 'list_profile_facts',
    description: 'Return current (non-historical) profile facts with confidence >= 0.6. Use when the user asks "what do you know about me?" or when you need to check whether a fact is already known.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_member UUID. Omit to return facts for all subjects.' },
      },
    },
  },
  {
    name: 'get_historical_facts',
    description: 'Return historical (deprecated) profile facts — things that used to be true. Use when the user asks about past preferences or history.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '"user" or a family_member UUID. Omit for all subjects.' },
      },
    },
  },
```

- [ ] **Step 4: Wire up case handlers**:

```typescript
case 'list_profile_facts':    result = await listProfileFacts(args as Parameters<typeof listProfileFacts>[0]); break
case 'get_historical_facts':  result = await getHistoricalFacts(args as Parameters<typeof getHistoricalFacts>[0]); break
```

- [ ] **Step 5: Build**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm run build
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat: add list_profile_facts and get_historical_facts MCP tools"
```

---

### Task 6: Update `get_profile_context` to include current facts

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Update the `getProfileContext` function** to add a `profile_facts` query and optional `include_historical` arg:

Replace the existing `getProfileContext` function:

```typescript
async function getProfileContext(args: { include_historical?: boolean } = {}) {
  const id = await uid()
  const [profileRes, locationsRes, familyRes, factsRes] = await Promise.all([
    db.from('user_profiles').select('dob, goals, interests, timezone').eq('user_id', id).maybeSingle(),
    db.from('user_locations').select('label, city, country, is_default').eq('user_id', id).order('created_at', { ascending: true }),
    db.from('family_members').select('name, relation, dob, gender, goals, interests').eq('user_id', id).order('created_at', { ascending: true }),
    db.from('profile_facts')
      .select('subject, predicate, value, confidence, is_historical, source')
      .eq('user_id', id)
      .gte('confidence', 0.6)
      .order('subject')
      .order('confidence', { ascending: false }),
  ])
  if (profileRes.error) throw new Error(profileRes.error.message)
  if (locationsRes.error) throw new Error(locationsRes.error.message)
  if (familyRes.error) throw new Error(familyRes.error.message)
  if (factsRes.error) throw new Error(factsRes.error.message)

  const allFacts = factsRes.data ?? []
  const currentFacts = allFacts.filter(f => !f.is_historical)
  const historicalFacts = allFacts.filter(f => f.is_historical)

  return {
    goals: profileRes.data?.goals ?? [],
    interests: profileRes.data?.interests ?? [],
    timezone: profileRes.data?.timezone ?? 'UTC',
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
      interests: m.interests,
    })),
    profile_facts: currentFacts.map(f => ({
      subject: f.subject,
      predicate: f.predicate,
      value: f.value,
      confidence: f.confidence,
    })),
    ...(args.include_historical ? {
      historical_facts: historicalFacts.map(f => ({
        subject: f.subject,
        predicate: f.predicate,
        value: f.value,
      })),
    } : {}),
  }
}
```

- [ ] **Step 2: Update the `get_profile_context` tool schema** to add the optional arg:

Find the existing `get_profile_context` tool entry and replace with:

```typescript
  {
    name: 'get_profile_context',
    description: 'Get the user\'s full profile context including goals, interests, locations, family members, and current profile facts. Pass include_historical: true to also receive facts that used to be true.',
    inputSchema: {
      type: 'object',
      properties: {
        include_historical: { type: 'boolean', description: 'If true, also return historical (past) facts alongside current ones' },
      },
    },
  },
```

- [ ] **Step 3: Update the case handler** — find `case 'get_profile_context'` and update:

```typescript
case 'get_profile_context': result = await getProfileContext(args as Parameters<typeof getProfileContext>[0]); break
```

- [ ] **Step 4: Build**

```bash
cd /Users/stroomnova/Music/plannen/mcp && npm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat: extend get_profile_context with profile_facts and include_historical"
```

---

### Task 7: Add profile-building instructions to CLAUDE.md and plannen skill

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/commands/plannen.md`

- [ ] **Step 1: Add the profile-building section to `CLAUDE.md`** (add after the existing "Source analysis" section):

```markdown
## Profile building

During every conversation, passively extract profile facts about the user and their family members.

- When the user mentions a family member's school, activity, or routine ("drop Niheet at Esdoorn"), a personal preference ("I prefer mornings"), a recurring location, or a characteristic ("Niheet is really into football lately"), treat it as a candidate fact.
- Call `upsert_profile_fact` **silently** (no user-facing message) with `source: "agent_inferred"`. Save at most **one fact per conversation turn**.
- If the user explicitly states a fact or corrects one, use `source: "user_stated"` or call `correct_profile_fact`.
- Never mention fact-saving to the user unless they ask.
- If the user asks "what do you know about me?" or similar, call `list_profile_facts` (and optionally `get_historical_facts`) and respond with a natural-language summary grouped by subject (user first, then each family member by name).
- `get_profile_context` already includes current profile facts — use it at session start to prime yourself.
```

- [ ] **Step 2: Add the same section to `.claude/commands/plannen.md`** (add before the "Output format" section):

```markdown
## Profile building

During every conversation, passively extract profile facts about the user and their family members.

- When the user mentions a family member's school, activity, or routine ("drop Niheet at Esdoorn"), a personal preference ("I prefer mornings"), a recurring location, or a characteristic ("Niheet is really into football lately"), treat it as a candidate fact.
- Call `upsert_profile_fact` **silently** (no user-facing message) with `source: "agent_inferred"`. Save at most **one fact per conversation turn**.
- If the user explicitly states a fact or corrects one, use `source: "user_stated"` or call `correct_profile_fact`.
- Never mention fact-saving to the user unless they ask.
- If the user asks "what do you know about me?" or similar, call `list_profile_facts` (and optionally `get_historical_facts`) and respond with a natural-language summary grouped by subject (user first, then each family member by name).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .claude/commands/plannen.md
git commit -m "feat: add profile-building instructions to CLAUDE.md and plannen skill"
```

---

### Task 8: End-to-end smoke test

- [ ] **Step 1: Reload MCP via `/mcp` in Claude Code**

- [ ] **Step 2: Test upsert — new fact**

Call from the MCP directly:
```
upsert_profile_fact({ subject: "user", predicate: "likes", value: "kayaking", source: "agent_inferred" })
```
Expected: `{ action: "inserted" }`

- [ ] **Step 3: Test corroboration**

Call again with the same args.
Expected: `{ action: "corroborated", confidence: 0.8 }`

- [ ] **Step 4: Test contradiction**

```
upsert_profile_fact({ subject: "user", predicate: "likes", value: "swimming", source: "user_stated" })
```
Expected: `{ action: "contradicted", old_value: "kayaking", new_value: "swimming" }`

- [ ] **Step 5: Verify list_profile_facts returns the new fact**

```
list_profile_facts({ subject: "user" })
```
Expected: array containing `{ predicate: "likes", value: "swimming", confidence: 1.0 }`

- [ ] **Step 6: Verify get_profile_context includes profile_facts**

```
get_profile_context({})
```
Expected: response includes `profile_facts` array with the swimming fact.

- [ ] **Step 7: Verify historical facts via get_historical_facts**

```
get_historical_facts({ subject: "user" })
```
Expected: contains `{ predicate: "likes", value: "kayaking" }` (marked historical by the contradiction).

- [ ] **Step 8: Test correction**

```
correct_profile_fact({ subject: "user", predicate: "likes", old_value: "swimming", new_value: "football" })
```
Then call `list_profile_facts` — should show `football`. Call `get_historical_facts` — should include `swimming`.

- [ ] **Step 9: Move backlog item to completed**

```bash
mv /Users/stroomnova/Music/plannen/backlog/profile-building.md /Users/stroomnova/Music/plannen/backlog/completed/
git add backlog/
git commit -m "chore: mark profile-building as completed"
```
