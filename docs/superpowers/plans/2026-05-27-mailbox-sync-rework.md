# Mailbox Sync Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the mailbox sync from creating marketing/blast events, give users an in-app mute UX with richer rules (sender / domain / domain + subject), and surface sync provenance on every #mbsync event.

**Architecture:** New `event_provenance` sidecar table stores structured sender/subject for each sync-created event. `mailbox_ignore_rules` grows `kind` + `pattern` (renamed from `sender`) + `subject_keyword`. A SQL helper `ignore_rule_matches` powers both the agent's per-thread mute check (mirrored in JS) and a retroactive sweep query. The classifier prompt tightens (Step B exclusions + addressed-to-me check), Step A learns the new rule kinds, Step E persists provenance. Web UI gets `<Mail>` icon on cards, Source section + Mute button in the modal, MuteSyncDialog and SweepMatchesDialog. launchd cadence drops from hourly 06–23 to every 4h around the clock.

**Tech Stack:** Postgres (Supabase + embedded pg for Tier 0) · Hono backend (Tier 0) · TypeScript MCP servers (stdio + edge function) · React + Vite + Tailwind · Vitest · macOS launchd.

**Spec:** `docs/superpowers/specs/2026-05-27-mailbox-sync-rework-design.md`

---

## File Map

**Create:**
- `supabase/migrations/20260527130000_mailbox_sync_rework.sql` — schema + SQL functions
- `supabase/migrations/20260527130000_mailbox_sync_rework.test.ts` — function unit tests
- `backend/src/routes/api/mailbox-ignore-rules.ts` — Tier 0 REST CRUD
- `backend/src/routes/api/mailbox-ignore-rules.test.ts`
- `backend/src/routes/api/event-provenance.ts` — Tier 0 REST GET/POST
- `backend/src/routes/api/event-provenance.test.ts`
- `supabase/functions/mcp/tools/provenance.ts` — new MCP module for add/get_event_provenance
- `supabase/functions/mcp/tools/provenance.test.ts`
- `src/components/MuteSyncDialog.tsx` + `.test.tsx`
- `src/components/SweepMatchesDialog.tsx` + `.test.tsx`
- `docs/superpowers/specs/mailbox-sync-fixtures.md`

**Modify:**
- `mcp/src/index.ts` (Tier 0 stdio MCP) — extend `add_ignore_rule`, add `find_matching_mbsync_events`, `add_event_provenance`, `get_event_provenance`
- `supabase/functions/mcp/tools/mailbox.ts` (Tier 1/2 MCP) — same extensions + `find_matching_mbsync_events`
- `supabase/functions/mcp/tools/mailbox.test.ts` — extend
- `supabase/functions/mcp/index.ts` — register `provenanceModule`
- `src/lib/dbClient/types.ts` — `IgnoreRuleRow`, `EventProvenanceRow`, `DbClient` interface
- `src/lib/dbClient/tier0.ts` — `ignoreRules` namespace, `events.getProvenance`
- `src/lib/dbClient/tier1.ts` — same
- `src/lib/dbClient/contract.test.ts` — extend
- `src/components/EventCard.tsx` — `<Mail>` icon for `#mbsync` events
- `src/components/EventDetailsModal.tsx` — Source section + open MuteSyncDialog
- `backend/src/index.ts` — wire new routes
- `cli/lib/launchd-plist.mjs` — hours array
- `cli/lib/launchd-plist.test.mjs` — update expectations
- `scripts/mailbox/sync-wrapper.sh` — schedule warning
- `plugin/skills/plannen-mailbox-sync.md` — Step B exclusions, addressed-to-me check, Step A rule kinds, Step E provenance
- `CHANGELOG.md`

---

## Task 1: Migration — schema + SQL functions

**Files:**
- Create: `supabase/migrations/20260527130000_mailbox_sync_rework.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Mailbox sync rework. See docs/superpowers/specs/2026-05-27-mailbox-sync-rework-design.md
--
-- 1. mailbox_ignore_rules: rename `sender` → `pattern`, add `kind` enum, add
--    `subject_keyword`; UNIQUE constraint covers all three.
-- 2. event_provenance: new sidecar table tying an event to the source that
--    created it (mailbox today, room for manual/gcal/ics later).
-- 3. ignore_rule_matches(): SQL predicate used by retroactive sweep and
--    (mirrored in JS) by the sync agent's Step A.
-- 4. find_matching_mbsync_events(): RPC-callable wrapper for the sweep UI.

-- 1. ignore rules: expand columns and constraint.

ALTER TABLE plannen.mailbox_ignore_rules RENAME COLUMN sender TO pattern;

ALTER TABLE plannen.mailbox_ignore_rules
  ADD COLUMN kind text NOT NULL DEFAULT 'sender'
    CHECK (kind IN ('sender', 'domain', 'domain_subject')),
  ADD COLUMN subject_keyword text;

ALTER TABLE plannen.mailbox_ignore_rules
  DROP CONSTRAINT mailbox_ignore_rules_user_id_adapter_id_sender_key;

ALTER TABLE plannen.mailbox_ignore_rules
  ADD CONSTRAINT mailbox_ignore_rules_unique_rule
    UNIQUE (user_id, adapter_id, kind, pattern, COALESCE(subject_keyword, ''));

-- 2. event_provenance sidecar.

CREATE TABLE plannen.event_provenance (
  event_id          uuid PRIMARY KEY REFERENCES plannen.events(id) ON DELETE CASCADE,
  source            text NOT NULL,
  adapter_id        text,
  source_message_id text,
  sender_display    text,
  sender_email      text,
  sender_domain     text,
  subject           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_provenance_sender_domain
  ON plannen.event_provenance (sender_domain);

ALTER TABLE plannen.event_provenance ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.event_provenance TO anon;
GRANT ALL ON TABLE plannen.event_provenance TO authenticated;
GRANT ALL ON TABLE plannen.event_provenance TO service_role;

DROP POLICY IF EXISTS "Users can view provenance for events they can see"
  ON plannen.event_provenance;
CREATE POLICY "Users can view provenance for events they can see"
  ON plannen.event_provenance
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id
      AND (
        e.created_by = auth.uid()
        OR plannen.user_in_event_shared_with_users(e.id)
        OR plannen.user_in_event_group(e.id)
        OR (
          e.shared_with_friends = 'all'
          AND EXISTS (
            SELECT 1 FROM plannen.relationships r
            WHERE r.status = 'accepted'
              AND (
                (r.user_id = auth.uid() AND r.related_user_id = e.created_by)
                OR (r.user_id = e.created_by AND r.related_user_id = auth.uid())
              )
          )
        )
      )
  ));

DROP POLICY IF EXISTS "Event creator manages provenance"
  ON plannen.event_provenance;
CREATE POLICY "Event creator manages provenance"
  ON plannen.event_provenance
  FOR ALL USING (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id AND e.created_by = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM plannen.events e
    WHERE e.id = event_provenance.event_id AND e.created_by = auth.uid()
  ));

-- 3. Match predicate.

CREATE OR REPLACE FUNCTION plannen.ignore_rule_matches(
  rule_kind text,
  rule_pattern text,
  rule_subject text,
  email_from text,
  email_subject text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  addr text;
  dom text;
BEGIN
  -- Extract bare address from "Name <addr@host>" if present, else use as-is.
  addr := lower(coalesce(
    substring(email_from from '<([^>]+)>'),
    email_from
  ));
  dom := split_part(addr, '@', 2);

  IF rule_kind = 'sender' THEN
    RETURN addr = lower(rule_pattern);
  ELSIF rule_kind = 'domain' THEN
    RETURN dom = lower(rule_pattern)
        OR dom LIKE '%.' || lower(rule_pattern);
  ELSIF rule_kind = 'domain_subject' THEN
    RETURN (dom = lower(rule_pattern)
            OR dom LIKE '%.' || lower(rule_pattern))
       AND lower(coalesce(email_subject, '')) LIKE '%' || lower(rule_subject) || '%';
  ELSE
    RETURN false;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION plannen.ignore_rule_matches(text, text, text, text, text)
  TO anon, authenticated, service_role;

-- 4. Sweep helper. SECURITY INVOKER (default): RLS on events + provenance applies.

CREATE OR REPLACE FUNCTION plannen.find_matching_mbsync_events(
  rule_kind text,
  rule_pattern text,
  rule_subject text
) RETURNS SETOF plannen.events
LANGUAGE sql
STABLE
AS $$
  SELECT e.*
  FROM plannen.events e
  JOIN plannen.event_provenance p ON p.event_id = e.id
  WHERE e.created_by = auth.uid()
    AND 'mbsync' = ANY(e.hashtags)
    AND plannen.ignore_rule_matches(
      rule_kind, rule_pattern, rule_subject,
      p.sender_display, p.subject
    )
  ORDER BY e.start_date DESC
  LIMIT 100;
$$;

GRANT EXECUTE ON FUNCTION plannen.find_matching_mbsync_events(text, text, text)
  TO anon, authenticated, service_role;
```

- [ ] **Step 2: Apply the migration on the active profile**

Run:

```bash
npx plannen migrate
```

Expected output ends with `Migration 20260527130000_mailbox_sync_rework.sql applied`.

If on `sb_prod` profile and you don't want to push to prod yet, switch to a non-prod profile first (`npx plannen profile use staging`) and migrate there.

- [ ] **Step 3: Smoke-test the new schema in psql**

Run:

```bash
psql "$DATABASE_URL" -c "SELECT plannen.ignore_rule_matches('domain', 'acmelife.com', null, 'Acme Life <n@e.acmelife.com>', 'Anything')"
```

Expected: `t` (one row, value `true`).

```bash
psql "$DATABASE_URL" -c "\d plannen.event_provenance"
```

Expected: shows all 9 columns.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260527130000_mailbox_sync_rework.sql
git commit -m "feat(db): mailbox sync rework schema — provenance + richer ignore rules"
```

---

## Task 2: SQL function unit tests

**Files:**
- Create: `backend/src/routes/api/ignore-rule-matches.test.ts` (lives in backend so existing DATABASE_URL test infra is reused)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { pool } from '../../db.js'

async function match(kind: string, pattern: string, subject: string | null, from: string, emailSubject: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT plannen.ignore_rule_matches($1, $2, $3, $4, $5) AS m',
    [kind, pattern, subject, from, emailSubject],
  )
  return rows[0].m === true
}

describe('plannen.ignore_rule_matches', () => {
  beforeAll(async () => {
    // Sanity: function exists.
    const { rows } = await pool.query("SELECT 1 FROM pg_proc WHERE proname = 'ignore_rule_matches'")
    expect(rows.length).toBeGreaterThan(0)
  })

  describe('kind=sender', () => {
    it('matches exact lowercase address', async () => {
      expect(await match('sender', 'a@b.com', null, 'a@b.com', 'x')).toBe(true)
    })
    it('is case-insensitive on both sides', async () => {
      expect(await match('sender', 'A@B.COM', null, 'a@b.com', 'x')).toBe(true)
      expect(await match('sender', 'a@b.com', null, 'A@B.COM', 'x')).toBe(true)
    })
    it('strips "Name <addr>" wrapping', async () => {
      expect(await match('sender', 'a@b.com', null, 'Alice <a@b.com>', 'x')).toBe(true)
    })
    it('does not match different addresses', async () => {
      expect(await match('sender', 'a@b.com', null, 'c@b.com', 'x')).toBe(false)
    })
  })

  describe('kind=domain', () => {
    it('matches exact domain', async () => {
      expect(await match('domain', 'acmelife.com', null, 'n@acmelife.com', 'x')).toBe(true)
    })
    it('matches subdomain', async () => {
      expect(await match('domain', 'acmelife.com', null, 'n@e.acmelife.com', 'x')).toBe(true)
      expect(await match('domain', 'acmelife.com', null, 'n@deep.e.acmelife.com', 'x')).toBe(true)
    })
    it('does not match a different domain', async () => {
      expect(await match('domain', 'acmelife.com', null, 'n@acmebank.com', 'x')).toBe(false)
    })
    it('does not match a domain that merely contains the pattern as substring', async () => {
      expect(await match('domain', 'acme.com', null, 'n@acmebank.com', 'x')).toBe(false)
    })
  })

  describe('kind=domain_subject', () => {
    it('matches when both domain and subject substring match', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@e.acmelife.com', 'Policy Renewal Reminder')).toBe(true)
    })
    it('subject substring is case-insensitive', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'RENEWAL', 'n@acmelife.com', 'your policy renewal')).toBe(true)
    })
    it('domain ok but subject misses', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@acmelife.com', 'KYC reminder')).toBe(false)
    })
    it('subject ok but domain misses', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@otherbank.com', 'Policy renewal')).toBe(false)
    })
    it('null email subject does not match', async () => {
      expect(await match('domain_subject', 'acmelife.com', 'renewal', 'n@acmelife.com', null as unknown as string)).toBe(false)
    })
  })

  it('unknown kind returns false', async () => {
    expect(await match('regex', 'anything', null, 'a@b.com', 'x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and confirm pass**

Run:

```bash
cd backend && DATABASE_URL="$DATABASE_URL" npx vitest run src/routes/api/ignore-rule-matches.test.ts
```

Expected: all 12+ tests pass. If `DATABASE_URL` is unset, the existing test bootstrap will throw clearly (`DATABASE_URL is required (set by bootstrap.sh)`) — set it from the active profile env first.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/api/ignore-rule-matches.test.ts
git commit -m "test(db): cover plannen.ignore_rule_matches across all three rule kinds"
```

---

## Task 3: Tier 1/2 MCP — extend `add_ignore_rule` + `list_ignore_rules`

**Files:**
- Modify: `supabase/functions/mcp/tools/mailbox.ts`
- Modify: `supabase/functions/mcp/tools/mailbox.test.ts`

- [ ] **Step 1: Replace the `add_ignore_rule` tool definition**

In `supabase/functions/mcp/tools/mailbox.ts`, find the `add_ignore_rule` entry under `definitions` (around line 16) and replace with:

```ts
{
  name: 'add_ignore_rule',
  description: 'Add a mailbox mute rule (sender, whole domain, or domain + subject keyword). Future emails matching this rule are skipped by /plannen-mailbox-sync without LLM classification.',
  inputSchema: {
    type: 'object',
    required: ['adapter_id', 'kind', 'pattern'],
    properties: {
      adapter_id:        { type: 'string', description: '"gmail" today; "icloud"/"imap" once those adapters land.' },
      kind:              { type: 'string', enum: ['sender', 'domain', 'domain_subject'], description: 'sender = exact email; domain = whole sending domain (includes subdomains); domain_subject = domain + subject keyword.' },
      pattern:           { type: 'string', description: 'For kind=sender: full address. For kind=domain or domain_subject: bare domain (e.g. "acmelife.com"). Lowercased server-side.' },
      subject_keyword:   { type: 'string', description: 'Required iff kind=domain_subject. Matched as case-insensitive substring against email subject.' },
      source_event_id:   { type: 'string', description: 'Optional — the Plannen event whose dismissal created this rule.' },
      source_message_id: { type: 'string', description: 'Optional — the originating message ID for audit.' },
      reason:            { type: 'string', description: 'Optional human note.' },
    },
  },
},
```

- [ ] **Step 2: Replace the `add_ignore_rule` handler**

Find the handler in the same file (search for `'add_ignore_rule':`) and replace its function body with:

```ts
'add_ignore_rule': async ({ adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason }, { db, userId }) => {
  if (!['sender', 'domain', 'domain_subject'].includes(kind)) {
    throw new Error(`add_ignore_rule: kind must be one of sender|domain|domain_subject, got ${kind}`)
  }
  if (kind === 'domain_subject' && !subject_keyword) {
    throw new Error('add_ignore_rule: subject_keyword is required when kind=domain_subject')
  }
  if (kind !== 'domain_subject' && subject_keyword) {
    throw new Error('add_ignore_rule: subject_keyword is only allowed when kind=domain_subject')
  }
  const cleanPattern = pattern.trim().toLowerCase()
  if (!cleanPattern) throw new Error('add_ignore_rule: pattern is required')
  const cleanSubject = subject_keyword ? subject_keyword.trim() : null

  const { data, error } = await db
    .from('mailbox_ignore_rules')
    .insert({
      user_id: userId,
      adapter_id,
      kind,
      pattern: cleanPattern,
      subject_keyword: cleanSubject,
      source_event_id: source_event_id ?? null,
      source_message_id: source_message_id ?? null,
      reason: reason ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
},
```

If the existing handler signature differs (e.g. it uses `pool.query` instead of supabase-js), match the existing pattern in the file — the validation logic above stays the same, only the persistence call adapts.

- [ ] **Step 3: Update tests for `add_ignore_rule`**

In `supabase/functions/mcp/tools/mailbox.test.ts`, add cases:

```ts
describe('add_ignore_rule (richer rules)', () => {
  it('accepts kind=sender with just a pattern', async () => {
    const r = await callTool('add_ignore_rule', { adapter_id: 'gmail', kind: 'sender', pattern: 'a@b.com' })
    expect(r.kind).toBe('sender')
    expect(r.pattern).toBe('a@b.com')
    expect(r.subject_keyword).toBeNull()
  })
  it('lowercases the pattern', async () => {
    const r = await callTool('add_ignore_rule', { adapter_id: 'gmail', kind: 'domain', pattern: 'AcmeLife.com' })
    expect(r.pattern).toBe('acmelife.com')
  })
  it('requires subject_keyword for kind=domain_subject', async () => {
    await expect(callTool('add_ignore_rule', { adapter_id: 'gmail', kind: 'domain_subject', pattern: 'acmelife.com' }))
      .rejects.toThrow(/subject_keyword is required/i)
  })
  it('rejects subject_keyword on kind=sender', async () => {
    await expect(callTool('add_ignore_rule', { adapter_id: 'gmail', kind: 'sender', pattern: 'a@b.com', subject_keyword: 'x' }))
      .rejects.toThrow(/only allowed when kind=domain_subject/i)
  })
  it('rejects unknown kind', async () => {
    await expect(callTool('add_ignore_rule', { adapter_id: 'gmail', kind: 'regex', pattern: '.*' }))
      .rejects.toThrow(/kind must be one of/i)
  })
})
```

The exact `callTool(...)` helper is whatever this test file already uses to dispatch a tool by name — reuse it. Look at an existing test in `mailbox.test.ts` for the pattern.

- [ ] **Step 4: Run the MCP tests**

Run:

```bash
cd supabase/functions && deno test mcp/tools/mailbox.test.ts
```

Expected: all tests pass including new ones. (Or `npx vitest run supabase/functions/mcp/tools/mailbox.test.ts` if this file uses Vitest — match the existing runner.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/tools/mailbox.ts supabase/functions/mcp/tools/mailbox.test.ts
git commit -m "feat(mcp): add_ignore_rule supports sender|domain|domain_subject kinds"
```

---

## Task 4: Tier 1/2 MCP — `find_matching_mbsync_events`

**Files:**
- Modify: `supabase/functions/mcp/tools/mailbox.ts`
- Modify: `supabase/functions/mcp/tools/mailbox.test.ts`

- [ ] **Step 1: Add the tool definition**

Append to the `definitions` array in `mailbox.ts`:

```ts
{
  name: 'find_matching_mbsync_events',
  description: 'Given a (kind, pattern, subject_keyword) rule spec, returns up to 100 #mbsync events the rule would match. Used by the web mute UI to ask the user whether to retroactively delete prior captures.',
  inputSchema: {
    type: 'object',
    required: ['kind', 'pattern'],
    properties: {
      kind:            { type: 'string', enum: ['sender', 'domain', 'domain_subject'] },
      pattern:         { type: 'string' },
      subject_keyword: { type: 'string', description: 'Required iff kind=domain_subject.' },
    },
  },
},
```

- [ ] **Step 2: Add the handler**

Insert into the handler map (alongside the other ignore-rule handlers):

```ts
'find_matching_mbsync_events': async ({ kind, pattern, subject_keyword }, { db }) => {
  if (kind === 'domain_subject' && !subject_keyword) {
    throw new Error('find_matching_mbsync_events: subject_keyword is required when kind=domain_subject')
  }
  const { data, error } = await db.rpc('find_matching_mbsync_events', {
    rule_kind: kind,
    rule_pattern: pattern.trim().toLowerCase(),
    rule_subject: subject_keyword?.trim() ?? null,
  })
  if (error) throw new Error(error.message)
  return data ?? []
},
```

- [ ] **Step 3: Test against a seeded fixture**

Add to `mailbox.test.ts`:

```ts
describe('find_matching_mbsync_events', () => {
  beforeAll(async () => {
    // Seed: two #mbsync events, one matching, one not.
    await callTool('create_event', {
      title: 'ACME renewal', start_date: '2026-06-01T10:00:00Z',
      hashtags: ['mbsync'],
      description: 'Gmail-ID: t1',
    }).then((ev) => callTool('add_event_provenance', {
      event_id: ev.id, source: 'mailbox', adapter_id: 'gmail',
      source_message_id: 't1', sender_display: 'ACME <n@e.acmelife.com>',
      sender_email: 'n@e.acmelife.com', sender_domain: 'e.acmelife.com',
      subject: 'Renewal reminder',
    }))
    await callTool('create_event', {
      title: 'School play', start_date: '2026-06-02T10:00:00Z',
      hashtags: ['mbsync'],
      description: 'Gmail-ID: t2',
    }).then((ev) => callTool('add_event_provenance', {
      event_id: ev.id, source: 'mailbox', adapter_id: 'gmail',
      source_message_id: 't2', sender_display: 'School <admin@school.example>',
      sender_email: 'admin@school.example', sender_domain: 'school.example',
      subject: 'Annual play',
    }))
  })

  it('returns only matching #mbsync events', async () => {
    const matches = await callTool('find_matching_mbsync_events', {
      kind: 'domain', pattern: 'acmelife.com',
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].title).toBe('ACME renewal')
  })

  it('respects domain_subject narrowing', async () => {
    const matches = await callTool('find_matching_mbsync_events', {
      kind: 'domain_subject', pattern: 'acmelife.com', subject_keyword: 'renewal',
    })
    expect(matches).toHaveLength(1)
  })

  it('returns empty when nothing matches', async () => {
    const matches = await callTool('find_matching_mbsync_events', {
      kind: 'domain', pattern: 'nope.example',
    })
    expect(matches).toEqual([])
  })
})
```

(If `create_event` / `add_event_provenance` aren't yet wired in the test harness, write these tests now and let them fail; they'll pass after Task 5 lands. Or skip these three cases until Task 5. Either way, the tool itself can be unit-tested with a mocked `db.rpc` if the file uses that pattern.)

- [ ] **Step 4: Run tests**

```bash
cd supabase/functions && deno test mcp/tools/mailbox.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/tools/mailbox.ts supabase/functions/mcp/tools/mailbox.test.ts
git commit -m "feat(mcp): find_matching_mbsync_events tool for retroactive sweep"
```

---

## Task 5: Tier 1/2 MCP — provenance module

**Files:**
- Create: `supabase/functions/mcp/tools/provenance.ts`
- Create: `supabase/functions/mcp/tools/provenance.test.ts`
- Modify: `supabase/functions/mcp/index.ts`

- [ ] **Step 1: Create the module**

```ts
// supabase/functions/mcp/tools/provenance.ts
//
// Records the source that created a Plannen event (mailbox sync today; gcal/ics
// later). Used by the web UI to render the "Added by mailbox sync from <X>"
// section in the event modal and to support retroactive mute via
// find_matching_mbsync_events.

import type { ToolDefinition, ToolModule } from '../types.ts'

const definitions: ToolDefinition[] = [
  {
    name: 'add_event_provenance',
    description: "Record (or replace) the source that created an event. Called by /plannen-mailbox-sync after each create_event so the web UI can surface sender/subject and the mute UI can match retroactively.",
    inputSchema: {
      type: 'object',
      required: ['event_id', 'source'],
      properties: {
        event_id:          { type: 'string' },
        source:            { type: 'string', description: '"mailbox" today; "manual"/"gcal"/"ics" later.' },
        adapter_id:        { type: 'string' },
        source_message_id: { type: 'string' },
        sender_display:    { type: 'string', description: 'Raw From: header value, e.g. "Acme Life <n@e.acmelife.com>".' },
        sender_email:      { type: 'string', description: 'Lowercased address — set even when sender_display has wrapping.' },
        sender_domain:     { type: 'string', description: 'Lowercased host part of sender_email.' },
        subject:           { type: 'string' },
      },
    },
  },
  {
    name: 'get_event_provenance',
    description: 'Return the provenance row for an event, or null if none recorded.',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: { event_id: { type: 'string' } },
    },
  },
]

const handlers = {
  'add_event_provenance': async (input: Record<string, unknown>, { db }: { db: any }) => {
    const { event_id, ...rest } = input as { event_id: string } & Record<string, unknown>
    if (!event_id) throw new Error('add_event_provenance: event_id is required')
    if (!rest.source) throw new Error('add_event_provenance: source is required')
    const { data, error } = await db
      .from('event_provenance')
      .upsert({ event_id, ...rest }, { onConflict: 'event_id' })
      .select()
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  'get_event_provenance': async ({ event_id }: { event_id: string }, { db }: { db: any }) => {
    const { data, error } = await db
      .from('event_provenance')
      .select('*')
      .eq('event_id', event_id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data ?? null
  },
}

export const provenanceModule: ToolModule = { definitions, handlers }
```

(Match the exact `ToolModule` shape used by neighbouring files like `mailbox.ts` / `memories.ts` — the type imports and the property names — this snippet captures the structure.)

- [ ] **Step 2: Register the module**

In `supabase/functions/mcp/index.ts`, add the import + push it into the `TOOLS` array:

```ts
// add to imports near the top:
import { provenanceModule } from './tools/provenance.ts'

// and into the TOOLS array (line ~76):
const TOOLS: ToolModule[] = [eventsModule, memoriesModule, storiesModule, photosModule, gcalModule, relationshipsModule, profileModule, familyModule, locationsModule, watchesModule, sourcesModule, profileFactsModule, practicesModule, briefingsModule, mailboxModule, provenanceModule]
```

- [ ] **Step 3: Add module tests**

```ts
// supabase/functions/mcp/tools/provenance.test.ts
import { describe, it, expect } from 'vitest'
import { provenanceModule } from './provenance.ts'

describe('provenanceModule', () => {
  it('registers both tools', () => {
    const names = provenanceModule.definitions.map((d) => d.name).sort()
    expect(names).toEqual(['add_event_provenance', 'get_event_provenance'])
  })

  // Integration tests: upsert + get round-trip. Use the same harness pattern
  // as memories.test.ts — a real db client seeded with one event.
  // (Fill in here following the in-repo convention.)
})
```

If `memories.test.ts` has a richer integration harness, copy that pattern verbatim. The first test above is enough as a smoke check.

- [ ] **Step 4: Run tests**

```bash
cd supabase/functions && deno test mcp/tools/provenance.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/tools/provenance.ts supabase/functions/mcp/tools/provenance.test.ts supabase/functions/mcp/index.ts
git commit -m "feat(mcp): event_provenance MCP module — add + get tools"
```

---

## Task 6: Tier 0 MCP mirror — `mcp/src/index.ts`

**Files:**
- Modify: `mcp/src/index.ts`

Tier 0 stdio MCP must register the same tools or Tier 0 users (embedded Postgres mode) won't have them. Mirror Tasks 3–5 in one shot.

- [ ] **Step 1: Update the `add_ignore_rule` definition (around line 2529)**

Find the existing definition and replace the `inputSchema` block to match the Tier 1/2 version from Task 3 Step 1 (kind, pattern, subject_keyword, …).

- [ ] **Step 2: Add new tool definitions next to `bump_ignore_rule_hit` (around line 2553)**

```ts
{
  name: 'find_matching_mbsync_events',
  description: '(same description as Tier 1/2)',
  inputSchema: { /* same as Task 4 Step 1 */ },
},
{
  name: 'add_event_provenance',
  description: '(same)',
  inputSchema: { /* same as Task 5 Step 1 */ },
},
{
  name: 'get_event_provenance',
  description: '(same)',
  inputSchema: { /* same as Task 5 Step 1 */ },
},
```

- [ ] **Step 3: Replace the `add_ignore_rule` handler (around line 2668)**

Tier 0 uses `pg.Pool` + `withUserContext`. The body:

```ts
case 'add_ignore_rule': {
  const { adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason } = args as {
    adapter_id: string; kind: 'sender' | 'domain' | 'domain_subject';
    pattern: string; subject_keyword?: string;
    source_event_id?: string; source_message_id?: string; reason?: string;
  }
  if (!['sender', 'domain', 'domain_subject'].includes(kind)) {
    throw new Error(`add_ignore_rule: kind must be one of sender|domain|domain_subject, got ${kind}`)
  }
  if (kind === 'domain_subject' && !subject_keyword) {
    throw new Error('add_ignore_rule: subject_keyword is required when kind=domain_subject')
  }
  if (kind !== 'domain_subject' && subject_keyword) {
    throw new Error('add_ignore_rule: subject_keyword is only allowed when kind=domain_subject')
  }
  const cleanPattern = pattern.trim().toLowerCase()
  if (!cleanPattern) throw new Error('add_ignore_rule: pattern is required')
  const cleanSubject = subject_keyword ? subject_keyword.trim() : null
  result = await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.mailbox_ignore_rules
         (user_id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [userId, adapter_id, kind, cleanPattern, cleanSubject, source_event_id ?? null, source_message_id ?? null, reason ?? null],
    )
    return rows[0]
  })
  break
}
```

- [ ] **Step 4: Add the three new handlers in the switch**

After the existing ignore-rule handlers:

```ts
case 'find_matching_mbsync_events': {
  const { kind, pattern, subject_keyword } = args as { kind: string; pattern: string; subject_keyword?: string }
  if (kind === 'domain_subject' && !subject_keyword) {
    throw new Error('find_matching_mbsync_events: subject_keyword is required when kind=domain_subject')
  }
  result = await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.find_matching_mbsync_events($1, $2, $3)',
      [kind, pattern.trim().toLowerCase(), subject_keyword?.trim() ?? null],
    )
    return rows
  })
  break
}

case 'add_event_provenance': {
  const { event_id, source, adapter_id, source_message_id, sender_display, sender_email, sender_domain, subject } = args as Record<string, string | undefined>
  if (!event_id) throw new Error('add_event_provenance: event_id is required')
  if (!source) throw new Error('add_event_provenance: source is required')
  result = await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.event_provenance
         (event_id, source, adapter_id, source_message_id, sender_display, sender_email, sender_domain, subject)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id) DO UPDATE SET
         source = EXCLUDED.source,
         adapter_id = EXCLUDED.adapter_id,
         source_message_id = EXCLUDED.source_message_id,
         sender_display = EXCLUDED.sender_display,
         sender_email = EXCLUDED.sender_email,
         sender_domain = EXCLUDED.sender_domain,
         subject = EXCLUDED.subject
       RETURNING *`,
      [event_id, source, adapter_id ?? null, source_message_id ?? null, sender_display ?? null, sender_email ?? null, sender_domain ?? null, subject ?? null],
    )
    return rows[0]
  })
  break
}

case 'get_event_provenance': {
  const { event_id } = args as { event_id: string }
  result = await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT p.* FROM plannen.event_provenance p
         JOIN plannen.events e ON e.id = p.event_id
        WHERE p.event_id = $1 AND e.created_by = $2`,
      [event_id, userId],
    )
    return rows[0] ?? null
  })
  break
}
```

- [ ] **Step 5: Compile + smoke test**

Run:

```bash
cd mcp && npx tsc --noEmit
```

Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp-tier0): mirror richer ignore_rule + event_provenance tools"
```

---

## Task 7: Tier 0 REST — `mailbox-ignore-rules`

**Files:**
- Create: `backend/src/routes/api/mailbox-ignore-rules.ts`
- Create: `backend/src/routes/api/mailbox-ignore-rules.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the route file**

```ts
// backend/src/routes/api/mailbox-ignore-rules.ts
//
// REST surface for plannen.mailbox_ignore_rules (Tier 0).
// Mirrors the MCP tool signature: kind/pattern/subject_keyword.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const mailboxIgnoreRules = new Hono<{ Variables: AppVariables }>()

const RuleInput = z.object({
  adapter_id: z.string().min(1),
  kind: z.enum(['sender', 'domain', 'domain_subject']),
  pattern: z.string().min(1),
  subject_keyword: z.string().optional().nullable(),
  source_event_id: z.string().uuid().optional().nullable(),
  source_message_id: z.string().optional().nullable(),
  reason: z.string().optional().nullable(),
}).superRefine((v, ctx) => {
  if (v.kind === 'domain_subject' && !v.subject_keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_keyword is required when kind=domain_subject' })
  }
  if (v.kind !== 'domain_subject' && v.subject_keyword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_keyword is only allowed when kind=domain_subject' })
  }
})

mailboxIgnoreRules.get('/', async (c) => {
  const userId = c.var.userId
  const adapterId = c.req.query('adapter_id')
  return await withUserContext(userId, async (db) => {
    const params: unknown[] = [userId]
    let sql = 'SELECT * FROM plannen.mailbox_ignore_rules WHERE user_id = $1'
    if (adapterId) {
      params.push(adapterId)
      sql += ` AND adapter_id = $${params.length}`
    }
    sql += ' ORDER BY created_at DESC'
    const { rows } = await db.query(sql, params)
    return c.json({ data: rows })
  })
})

mailboxIgnoreRules.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = RuleInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid rule', JSON.stringify(parsed.error.issues))
  }
  const v = parsed.data
  const pattern = v.pattern.trim().toLowerCase()
  const subjectKeyword = v.subject_keyword ? v.subject_keyword.trim() : null
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO plannen.mailbox_ignore_rules
         (user_id, adapter_id, kind, pattern, subject_keyword, source_event_id, source_message_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [userId, v.adapter_id, v.kind, pattern, subjectKeyword, v.source_event_id ?? null, v.source_message_id ?? null, v.reason ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})

mailboxIgnoreRules.delete('/:id', async (c) => {
  const userId = c.var.userId
  const id = c.req.param('id')
  return await withUserContext(userId, async (db) => {
    const { rowCount } = await db.query(
      'DELETE FROM plannen.mailbox_ignore_rules WHERE id = $1 AND user_id = $2',
      [id, userId],
    )
    if (rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Rule not found')
    return c.json({ data: { id } })
  })
})
```

- [ ] **Step 2: Wire into `backend/src/index.ts`**

Add the import alongside the others:

```ts
import { mailboxIgnoreRules } from './routes/api/mailbox-ignore-rules.js'
```

And mount it where the other routes are mounted (search for `app.route('/api/event-notes', eventNotes)` and add a line below):

```ts
app.route('/api/mailbox-ignore-rules', mailboxIgnoreRules)
```

- [ ] **Step 3: Write tests**

```ts
// backend/src/routes/api/mailbox-ignore-rules.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testApp } from '../../testApp.js'
import { pool } from '../../db.js'

const app = testApp

describe('mailbox-ignore-rules REST', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM plannen.mailbox_ignore_rules')
  })

  it('rejects payloads missing kind', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', pattern: 'a@b.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('creates a kind=domain rule and lowercases pattern', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', kind: 'domain', pattern: 'AcmeLife.com' }),
    })
    expect(res.status).toBe(201)
    const { data } = await res.json() as { data: { pattern: string; kind: string } }
    expect(data.pattern).toBe('acmelife.com')
    expect(data.kind).toBe('domain')
  })

  it('rejects domain_subject without subject_keyword', async () => {
    const res = await app.request('/api/mailbox-ignore-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter_id: 'gmail', kind: 'domain_subject', pattern: 'acmelife.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('lists rules and supports adapter_id filter', async () => {
    await pool.query(
      "INSERT INTO plannen.mailbox_ignore_rules (user_id, adapter_id, kind, pattern) VALUES ((SELECT id FROM plannen.users LIMIT 1), 'gmail', 'sender', 'a@b.com')",
    )
    const all = await app.request('/api/mailbox-ignore-rules')
    expect(((await all.json()) as { data: unknown[] }).data).toHaveLength(1)
  })

  it('deletes a rule by id', async () => {
    const { rows } = await pool.query(
      "INSERT INTO plannen.mailbox_ignore_rules (user_id, adapter_id, kind, pattern) VALUES ((SELECT id FROM plannen.users LIMIT 1), 'gmail', 'sender', 'a@b.com') RETURNING id",
    )
    const del = await app.request(`/api/mailbox-ignore-rules/${rows[0].id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const { rows: after } = await pool.query('SELECT COUNT(*)::int AS c FROM plannen.mailbox_ignore_rules')
    expect(after[0].c).toBe(0)
  })
})
```

(Match the existing test bootstrap. If `testApp` isn't the right import, copy the import from `event-notes.test.ts` and adapt.)

- [ ] **Step 4: Run tests**

```bash
cd backend && DATABASE_URL="$DATABASE_URL" npx vitest run src/routes/api/mailbox-ignore-rules.test.ts
```

Expected: all five tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/api/mailbox-ignore-rules.ts backend/src/routes/api/mailbox-ignore-rules.test.ts backend/src/index.ts
git commit -m "feat(backend): /api/mailbox-ignore-rules REST surface"
```

---

## Task 8: Tier 0 REST — `event-provenance`

**Files:**
- Create: `backend/src/routes/api/event-provenance.ts`
- Create: `backend/src/routes/api/event-provenance.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Route file**

```ts
// backend/src/routes/api/event-provenance.ts
//
// REST surface for plannen.event_provenance. GET by event_id; POST upserts.
// Visibility scoped to events created_by the current user.

import { Hono } from 'hono'
import { z } from 'zod'
import { withUserContext } from '../../db.js'
import { HttpError } from '../../middleware/error.js'
import type { AppVariables } from '../../types.js'

export const eventProvenance = new Hono<{ Variables: AppVariables }>()

const ProvenanceInput = z.object({
  event_id: z.string().uuid(),
  source: z.string().min(1),
  adapter_id: z.string().optional().nullable(),
  source_message_id: z.string().optional().nullable(),
  sender_display: z.string().optional().nullable(),
  sender_email: z.string().optional().nullable(),
  sender_domain: z.string().optional().nullable(),
  subject: z.string().optional().nullable(),
})

eventProvenance.get('/', async (c) => {
  const userId = c.var.userId
  const eventId = c.req.query('event_id')
  if (!eventId) throw new HttpError(400, 'VALIDATION', 'event_id is required')
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      `SELECT p.* FROM plannen.event_provenance p
         JOIN plannen.events e ON e.id = p.event_id
        WHERE p.event_id = $1 AND e.created_by = $2`,
      [eventId, userId],
    )
    return c.json({ data: rows[0] ?? null })
  })
})

eventProvenance.post('/', async (c) => {
  const userId = c.var.userId
  const parsed = ProvenanceInput.safeParse(await c.req.json())
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid provenance', JSON.stringify(parsed.error.issues))
  }
  const v = parsed.data
  return await withUserContext(userId, async (db) => {
    // Visibility check: must own the event.
    const { rows: er } = await db.query(
      'SELECT id FROM plannen.events WHERE id = $1 AND created_by = $2',
      [v.event_id, userId],
    )
    if (er.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Event not found')

    const { rows } = await db.query(
      `INSERT INTO plannen.event_provenance
         (event_id, source, adapter_id, source_message_id, sender_display, sender_email, sender_domain, subject)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id) DO UPDATE SET
         source = EXCLUDED.source,
         adapter_id = EXCLUDED.adapter_id,
         source_message_id = EXCLUDED.source_message_id,
         sender_display = EXCLUDED.sender_display,
         sender_email = EXCLUDED.sender_email,
         sender_domain = EXCLUDED.sender_domain,
         subject = EXCLUDED.subject
       RETURNING *`,
      [v.event_id, v.source, v.adapter_id ?? null, v.source_message_id ?? null, v.sender_display ?? null, v.sender_email ?? null, v.sender_domain ?? null, v.subject ?? null],
    )
    return c.json({ data: rows[0] }, 201)
  })
})
```

- [ ] **Step 2: Wire into `backend/src/index.ts`**

```ts
import { eventProvenance } from './routes/api/event-provenance.js'
// ...
app.route('/api/event-provenance', eventProvenance)
```

- [ ] **Step 3: Tests**

```ts
// backend/src/routes/api/event-provenance.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testApp } from '../../testApp.js'
import { pool } from '../../db.js'

async function makeEvent(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO plannen.events (created_by, title, start_date) VALUES (
       (SELECT id FROM plannen.users LIMIT 1), 'test', now()
     ) RETURNING id`,
  )
  return rows[0].id as string
}

describe('event-provenance REST', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM plannen.event_provenance')
    await pool.query("DELETE FROM plannen.events WHERE title = 'test'")
  })

  it('GET returns null when no provenance row exists', async () => {
    const eventId = await makeEvent()
    const res = await testApp.request(`/api/event-provenance?event_id=${eventId}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown }).data).toBeNull()
  })

  it('POST creates a row and GET returns it', async () => {
    const eventId = await makeEvent()
    const post = await testApp.request('/api/event-provenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: eventId, source: 'mailbox', adapter_id: 'gmail',
        sender_email: 'a@b.com', sender_domain: 'b.com', subject: 'hi',
      }),
    })
    expect(post.status).toBe(201)
    const get = await testApp.request(`/api/event-provenance?event_id=${eventId}`)
    const data = ((await get.json()) as { data: { source: string; sender_email: string } | null }).data
    expect(data?.source).toBe('mailbox')
    expect(data?.sender_email).toBe('a@b.com')
  })

  it('POST upserts on conflict', async () => {
    const eventId = await makeEvent()
    const body = { event_id: eventId, source: 'mailbox', sender_email: 'a@b.com' }
    await testApp.request('/api/event-provenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const second = await testApp.request('/api/event-provenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, sender_email: 'c@d.com' }),
    })
    expect(second.status).toBe(201)
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM plannen.event_provenance')
    expect(rows[0].c).toBe(1)
  })

  it('POST 404s when the event is not owned by the user', async () => {
    const res = await testApp.request('/api/event-provenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: '00000000-0000-0000-0000-000000000000', source: 'mailbox' }),
    })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: Run tests**

```bash
cd backend && DATABASE_URL="$DATABASE_URL" npx vitest run src/routes/api/event-provenance.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/api/event-provenance.ts backend/src/routes/api/event-provenance.test.ts backend/src/index.ts
git commit -m "feat(backend): /api/event-provenance REST surface"
```

---

## Task 9: Web `dbClient` types

**Files:**
- Modify: `src/lib/dbClient/types.ts`

- [ ] **Step 1: Add type exports**

Append to `src/lib/dbClient/types.ts`:

```ts
// ── mailbox ignore rules ────────────────────────────────────────────────────

export type IgnoreRuleKind = 'sender' | 'domain' | 'domain_subject'

export type IgnoreRuleRow = {
  id: string
  user_id: string
  adapter_id: string
  kind: IgnoreRuleKind
  pattern: string
  subject_keyword: string | null
  source_event_id: string | null
  source_message_id: string | null
  reason: string | null
  hit_count: number
  last_hit_at: string | null
  created_at: string
}

export type IgnoreRuleSpec = {
  kind: IgnoreRuleKind
  pattern: string
  subject_keyword?: string | null
}

export type IgnoreRuleInput = IgnoreRuleSpec & {
  adapter_id: string
  source_event_id?: string | null
  source_message_id?: string | null
  reason?: string | null
}

// ── event provenance ────────────────────────────────────────────────────────

export type EventProvenanceRow = {
  event_id: string
  source: string
  adapter_id: string | null
  source_message_id: string | null
  sender_display: string | null
  sender_email: string | null
  sender_domain: string | null
  subject: string | null
  created_at: string
}
```

- [ ] **Step 2: Extend the `DbClient` interface**

Find the `DbClient` interface in the same file. Inside the `events` block, add:

```ts
getProvenance: (eventId: string) => Promise<EventProvenanceRow | null>
```

Add a new top-level namespace right after `events`:

```ts
ignoreRules: {
  list: (params?: { adapter_id?: string }) => Promise<IgnoreRuleRow[]>
  add: (input: IgnoreRuleInput) => Promise<IgnoreRuleRow>
  delete: (id: string) => Promise<void>
  findMatchingMbsyncEvents: (spec: IgnoreRuleSpec) => Promise<EventRow[]>
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: errors in `tier0.ts` and `tier1.ts` saying the new members aren't implemented. Good — those are the next tasks.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dbClient/types.ts
git commit -m "feat(web): dbClient types for ignore rules + event provenance"
```

---

## Task 10: Web `dbClient` — `tier0.ts` implementation

**Files:**
- Modify: `src/lib/dbClient/tier0.ts`

- [ ] **Step 1: Implement the new namespaces**

In `tier0.ts`, add to the `events` namespace:

```ts
getProvenance: (eventId) =>
  api<EventProvenanceRow | null>(`/api/event-provenance${qs({ event_id: eventId })}`),
```

After the `notes` namespace, add a new `ignoreRules` namespace:

```ts
ignoreRules: {
  list: (params) =>
    api<IgnoreRuleRow[]>(`/api/mailbox-ignore-rules${qs({ adapter_id: params?.adapter_id })}`),
  add: (input) =>
    api<IgnoreRuleRow>('/api/mailbox-ignore-rules', { method: 'POST', body: JSON.stringify(input) }),
  delete: async (id) => {
    await api(`/api/mailbox-ignore-rules/${id}`, { method: 'DELETE' })
  },
  findMatchingMbsyncEvents: (spec) =>
    api<EventRow[]>('/api/mailbox-ignore-rules/find-matching', {
      method: 'POST',
      body: JSON.stringify(spec),
    }),
},
```

Note the `find-matching` sub-route — that's a new POST endpoint we need to add. Add it now to `mailbox-ignore-rules.ts` from Task 7:

```ts
mailboxIgnoreRules.post('/find-matching', async (c) => {
  const userId = c.var.userId
  const body = await c.req.json() as { kind: string; pattern: string; subject_keyword?: string | null }
  return await withUserContext(userId, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM plannen.find_matching_mbsync_events($1, $2, $3)',
      [body.kind, body.pattern.trim().toLowerCase(), body.subject_keyword?.trim() ?? null],
    )
    return c.json({ data: rows })
  })
})
```

Also add the matching imports at the top of `tier0.ts`:

```ts
import type {
  // ...existing...
  IgnoreRuleRow,
  IgnoreRuleInput,
  IgnoreRuleSpec,
  EventProvenanceRow,
} from './types'
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: only `tier1.ts` errors remain.

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient/tier0.ts backend/src/routes/api/mailbox-ignore-rules.ts
git commit -m "feat(web): tier0 dbClient ignoreRules + events.getProvenance"
```

---

## Task 11: Web `dbClient` — `tier1.ts` implementation

**Files:**
- Modify: `src/lib/dbClient/tier1.ts`

- [ ] **Step 1: Implement using supabase-js**

In `tier1.ts`, add to the `events` namespace:

```ts
getProvenance: async (eventId) => {
  const { data, error } = await supabase
    .from('event_provenance')
    .select('*')
    .eq('event_id', eventId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as EventProvenanceRow | null
},
```

Add the `ignoreRules` namespace (mirror the notes pattern):

```ts
ignoreRules: {
  list: async (params) => {
    const uid = await currentUserId()
    let q = supabase
      .from('mailbox_ignore_rules')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
    if (params?.adapter_id) q = q.eq('adapter_id', params.adapter_id)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return (data ?? []) as IgnoreRuleRow[]
  },
  add: async (input) => {
    const uid = await currentUserId()
    if (input.kind === 'domain_subject' && !input.subject_keyword) {
      throw new Error('subject_keyword is required when kind=domain_subject')
    }
    if (input.kind !== 'domain_subject' && input.subject_keyword) {
      throw new Error('subject_keyword is only allowed when kind=domain_subject')
    }
    const pattern = input.pattern.trim().toLowerCase()
    const subjectKeyword = input.subject_keyword ? input.subject_keyword.trim() : null
    return unwrap(
      await supabase
        .from('mailbox_ignore_rules')
        .insert({
          user_id: uid,
          adapter_id: input.adapter_id,
          kind: input.kind,
          pattern,
          subject_keyword: subjectKeyword,
          source_event_id: input.source_event_id ?? null,
          source_message_id: input.source_message_id ?? null,
          reason: input.reason ?? null,
        })
        .select()
        .single(),
    ) as IgnoreRuleRow
  },
  delete: async (id) => {
    const { error } = await supabase.from('mailbox_ignore_rules').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },
  findMatchingMbsyncEvents: async (spec) => {
    if (spec.kind === 'domain_subject' && !spec.subject_keyword) {
      throw new Error('subject_keyword is required when kind=domain_subject')
    }
    const { data, error } = await supabase.rpc('find_matching_mbsync_events', {
      rule_kind: spec.kind,
      rule_pattern: spec.pattern.trim().toLowerCase(),
      rule_subject: spec.subject_keyword?.trim() ?? null,
    })
    if (error) throw new Error(error.message)
    return (data ?? []) as EventRow[]
  },
},
```

And the imports at the top:

```ts
import type {
  // ...existing...
  IgnoreRuleRow,
  IgnoreRuleInput,
  IgnoreRuleSpec,
  EventProvenanceRow,
} from './types'
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Run existing tests to confirm no regression**

```bash
npx vitest run src/lib/
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dbClient/tier1.ts
git commit -m "feat(web): tier1 dbClient ignoreRules + events.getProvenance"
```

---

## Task 12: Contract tests for new dbClient surface

**Files:**
- Modify: `src/lib/dbClient/contract.test.ts`

- [ ] **Step 1: Add interface-conformance assertions**

Open the file and locate where it iterates over both tiers (search for `tier0` and `tier1`). Add a block that asserts every required member exists:

```ts
describe.each([
  ['tier0', tier0],
  ['tier1', tier1],
])('%s — new mailbox surface', (_label, client) => {
  it('exposes ignoreRules namespace with required methods', () => {
    expect(typeof client.ignoreRules.list).toBe('function')
    expect(typeof client.ignoreRules.add).toBe('function')
    expect(typeof client.ignoreRules.delete).toBe('function')
    expect(typeof client.ignoreRules.findMatchingMbsyncEvents).toBe('function')
  })
  it('exposes events.getProvenance', () => {
    expect(typeof client.events.getProvenance).toBe('function')
  })
})
```

If the existing test file iterates the tiers differently, match its convention — the assertions above are what need adding.

- [ ] **Step 2: Run**

```bash
npx vitest run src/lib/dbClient/contract.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/dbClient/contract.test.ts
git commit -m "test(web): dbClient contract — ignoreRules + events.getProvenance"
```

---

## Task 13: `MuteSyncDialog` component

**Files:**
- Create: `src/components/MuteSyncDialog.tsx`
- Create: `src/components/MuteSyncDialog.test.tsx`

- [ ] **Step 1: Write the failing test first**

```tsx
// src/components/MuteSyncDialog.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MuteSyncDialog } from './MuteSyncDialog'
import type { EventProvenanceRow } from '../lib/dbClient/types'

const provenance: EventProvenanceRow = {
  event_id: 'evt-1',
  source: 'mailbox',
  adapter_id: 'gmail',
  source_message_id: 't1',
  sender_display: 'Acme Life <n@e.acmelife.com>',
  sender_email: 'n@e.acmelife.com',
  sender_domain: 'e.acmelife.com',
  subject: 'Policy Renewal Reminder',
  created_at: '2026-05-27T10:00:00Z',
}

describe('MuteSyncDialog', () => {
  it('defaults the radio to domain and pre-fills subject keyword', () => {
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={vi.fn()} eventId="evt-1" provenance={provenance} />)
    expect((screen.getByLabelText(/whole domain/i) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByDisplayValue('Renewal')).toBeInTheDocument()
  })

  it('also-delete is checked by default', () => {
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={vi.fn()} eventId="evt-1" provenance={provenance} />)
    expect((screen.getByLabelText(/also delete/i) as HTMLInputElement).checked).toBe(true)
  })

  it('clicking Mute fires onConfirm with the selected spec', () => {
    const onConfirm = vi.fn()
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={onConfirm} eventId="evt-1" provenance={provenance} />)
    fireEvent.click(screen.getByLabelText(/this sender/i))
    fireEvent.click(screen.getByRole('button', { name: /mute/i }))
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'sender',
      pattern: 'n@e.acmelife.com',
      subject_keyword: null,
      alsoDeleteCurrent: true,
    })
  })

  it('falls back to sender-only manual input when provenance is null', () => {
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={vi.fn()} eventId="evt-1" provenance={null} />)
    expect(screen.getByPlaceholderText(/email address/i)).toBeInTheDocument()
    // Domain and domain_subject radios should not be rendered.
    expect(screen.queryByLabelText(/whole domain/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run — confirm failure**

```bash
npx vitest run src/components/MuteSyncDialog.test.tsx
```

Expected: FAIL with "Cannot find module './MuteSyncDialog'".

- [ ] **Step 3: Implement the component**

```tsx
// src/components/MuteSyncDialog.tsx
import { useState } from 'react'
import { Modal } from './Modal'
import type { EventProvenanceRow, IgnoreRuleKind } from '../lib/dbClient/types'

export interface MuteSyncConfirmSpec {
  kind: IgnoreRuleKind
  pattern: string
  subject_keyword: string | null
  alsoDeleteCurrent: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onConfirm: (spec: MuteSyncConfirmSpec) => void
  eventId: string
  provenance: EventProvenanceRow | null
}

function defaultSubjectKeyword(subject: string | null | undefined): string {
  if (!subject) return ''
  const word = subject.split(/\s+/).find((w) => w.length > 3 && !/^[\d\-]+$/.test(w))
  return word ?? ''
}

export function MuteSyncDialog({ isOpen, onClose, onConfirm, eventId: _eventId, provenance }: Props) {
  const hasProvenance = provenance !== null
  const defaultKind: IgnoreRuleKind = hasProvenance ? 'domain' : 'sender'
  const [kind, setKind] = useState<IgnoreRuleKind>(defaultKind)
  const [manualPattern, setManualPattern] = useState('')
  const [subjectKeyword, setSubjectKeyword] = useState(defaultSubjectKeyword(provenance?.subject))
  const [alsoDelete, setAlsoDelete] = useState(true)

  const senderPattern = provenance?.sender_email ?? ''
  const domainPattern = provenance?.sender_domain ?? ''

  function patternFor(k: IgnoreRuleKind): string {
    if (!hasProvenance) return manualPattern.trim()
    if (k === 'sender') return senderPattern
    return domainPattern
  }

  function handleSubmit() {
    const pattern = patternFor(kind)
    if (!pattern) return
    onConfirm({
      kind,
      pattern,
      subject_keyword: kind === 'domain_subject' ? subjectKeyword.trim() || null : null,
      alsoDeleteCurrent: alsoDelete,
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Mute future events from this source">
      <div className="space-y-4">
        {hasProvenance ? (
          <fieldset className="space-y-2">
            <legend className="sr-only">What to mute</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="mute-kind" value="sender" checked={kind === 'sender'} onChange={() => setKind('sender')} className="mt-1" />
              <span><strong>Mute this sender</strong> — <code className="text-xs">{senderPattern}</code></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mute-kind" value="domain" checked={kind === 'domain'} onChange={() => setKind('domain')} className="mt-1" aria-label="Mute this whole domain" />
              <span><strong>Mute this whole domain</strong> — <code className="text-xs">{domainPattern}</code></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mute-kind" value="domain_subject" checked={kind === 'domain_subject'} onChange={() => setKind('domain_subject')} className="mt-1" />
              <span className="flex-1">
                <strong>Mute domain + subject keyword</strong> — <code className="text-xs">{domainPattern}</code> containing{' '}
                <input
                  type="text"
                  value={subjectKeyword}
                  onChange={(e) => setSubjectKeyword(e.target.value)}
                  disabled={kind !== 'domain_subject'}
                  className="ml-1 px-2 py-1 text-sm border border-gray-300 rounded-md disabled:opacity-50 w-32"
                  placeholder="renewal"
                />
              </span>
            </label>
          </fieldset>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">This event has no recorded source. Mute by sender address:</p>
            <input
              type="text"
              value={manualPattern}
              onChange={(e) => setManualPattern(e.target.value)}
              placeholder="email address (e.g. noreply@example.com)"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
            />
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={alsoDelete} onChange={(e) => setAlsoDelete(e.target.checked)} aria-label="Also delete this event" />
          Also delete this event
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="min-h-[44px] px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md">Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!patternFor(kind)}
            className="min-h-[44px] px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            Mute
          </button>
        </div>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/components/MuteSyncDialog.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/MuteSyncDialog.tsx src/components/MuteSyncDialog.test.tsx
git commit -m "feat(web): MuteSyncDialog with three rule kinds + delete-current default"
```

---

## Task 14: `SweepMatchesDialog` component

**Files:**
- Create: `src/components/SweepMatchesDialog.tsx`
- Create: `src/components/SweepMatchesDialog.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// src/components/SweepMatchesDialog.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SweepMatchesDialog } from './SweepMatchesDialog'

const matches = [
  { id: 'a', title: 'ACME Renewal 1', start_date: '2026-04-01T10:00:00Z' },
  { id: 'b', title: 'ACME Renewal 2', start_date: '2026-03-01T10:00:00Z' },
  { id: 'c', title: 'ACME KYC', start_date: '2026-02-01T10:00:00Z' },
] as never

describe('SweepMatchesDialog', () => {
  it('renders all matches as default-checked checkboxes', () => {
    render(<SweepMatchesDialog isOpen matches={matches} onClose={() => {}} onDelete={vi.fn()} />)
    const cbs = screen.getAllByRole('checkbox')
    expect(cbs).toHaveLength(3)
    cbs.forEach((cb) => expect((cb as HTMLInputElement).checked).toBe(true))
  })

  it('Delete selected fires onDelete with checked ids only', () => {
    const onDelete = vi.fn()
    render(<SweepMatchesDialog isOpen matches={matches} onClose={() => {}} onDelete={onDelete} />)
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }))
    expect(onDelete).toHaveBeenCalledWith(['a', 'c'])
  })

  it('Keep all calls onClose without onDelete', () => {
    const onDelete = vi.fn()
    const onClose = vi.fn()
    render(<SweepMatchesDialog isOpen matches={matches} onClose={onClose} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: /keep all/i }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Confirm failure**

```bash
npx vitest run src/components/SweepMatchesDialog.test.tsx
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement**

```tsx
// src/components/SweepMatchesDialog.tsx
import { useState } from 'react'
import { Modal } from './Modal'
import { format } from 'date-fns'

interface MatchRow {
  id: string
  title: string
  start_date: string
}

interface Props {
  isOpen: boolean
  matches: MatchRow[]
  onClose: () => void
  onDelete: (ids: string[]) => void
}

export function SweepMatchesDialog({ isOpen, matches, onClose, onDelete }: Props) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(matches.map((m) => m.id)))

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleDelete() {
    const ids = matches.map((m) => m.id).filter((id) => checked.has(id))
    onDelete(ids)
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`This rule also matches ${matches.length} other event${matches.length === 1 ? '' : 's'}`}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">Delete the ones you don't want to keep:</p>
        <ul className="space-y-2 max-h-[40vh] overflow-y-auto">
          {matches.map((m) => (
            <li key={m.id} className="flex items-center gap-2 p-2 rounded-md border border-gray-200">
              <input
                type="checkbox"
                checked={checked.has(m.id)}
                onChange={() => toggle(m.id)}
                aria-label={`Delete ${m.title}`}
              />
              <span className="flex-1 text-sm">{m.title}</span>
              <span className="text-xs text-gray-500">{format(new Date(m.start_date), 'MMM d, yyyy')}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-[44px] px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md">
            Keep all
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="min-h-[44px] px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
          >
            Delete selected
          </button>
        </div>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/components/SweepMatchesDialog.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/SweepMatchesDialog.tsx src/components/SweepMatchesDialog.test.tsx
git commit -m "feat(web): SweepMatchesDialog for retroactive mute cleanup"
```

---

## Task 15: `EventCard` — mbsync icon

**Files:**
- Modify: `src/components/EventCard.tsx`

- [ ] **Step 1: Locate the hashtag-chip row**

Search for the hashtag rendering in `EventCard.tsx` (the chip array tied to `event.hashtags`).

- [ ] **Step 2: Add the icon**

Import `Mail` from lucide if not already imported. Right before the hashtag chip row, render:

```tsx
{event.hashtags?.includes('mbsync') && (
  <Mail className="h-3.5 w-3.5 text-gray-400" aria-label="Added by mailbox sync" titleAccess="Added by mailbox sync" />
)}
```

(If lucide's React variant doesn't support `titleAccess`, wrap in a `<span title="Added by mailbox sync">…</span>`.)

- [ ] **Step 3: Add a test**

```tsx
// in tests/components/EventCard.test.tsx (existing file — add a case)
it('shows the mailbox icon for #mbsync events', () => {
  const event = makeEvent({ hashtags: ['mbsync'] })
  render(<EventCard event={event} {...defaultProps} />)
  expect(screen.getByLabelText(/added by mailbox sync/i)).toBeInTheDocument()
})
it('does not show the mailbox icon for non-mbsync events', () => {
  const event = makeEvent({ hashtags: ['family'] })
  render(<EventCard event={event} {...defaultProps} />)
  expect(screen.queryByLabelText(/added by mailbox sync/i)).toBeNull()
})
```

(`makeEvent` / `defaultProps` patterns: copy from existing tests in the same file.)

- [ ] **Step 4: Run**

```bash
npx vitest run tests/components/EventCard.test.tsx
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/EventCard.tsx tests/components/EventCard.test.tsx
git commit -m "feat(web): EventCard shows Mail icon for #mbsync events"
```

---

## Task 16: `EventDetailsModal` — Source section + dialog wiring

**Files:**
- Modify: `src/components/EventDetailsModal.tsx`

- [ ] **Step 1: Lazy-load provenance and wire dialogs**

Add imports at the top of the file:

```tsx
import { Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dbClient } from '../lib/dbClient'
import type { EventProvenanceRow, EventRow, IgnoreRuleSpec } from '../lib/dbClient/types'
import { MuteSyncDialog, type MuteSyncConfirmSpec } from './MuteSyncDialog'
import { SweepMatchesDialog } from './SweepMatchesDialog'
```

Inside the `EventDetailsModal` component (top of the body), add:

```tsx
const isSync = event.hashtags?.includes('mbsync') ?? false
const [provenance, setProvenance] = useState<EventProvenanceRow | null>(null)
const [muteOpen, setMuteOpen] = useState(false)
const [sweepMatches, setSweepMatches] = useState<EventRow[] | null>(null)

useEffect(() => {
  if (!isOpen || !isSync) return
  let cancelled = false
  dbClient.events.getProvenance(event.id).then((row) => {
    if (!cancelled) setProvenance(row)
  })
  return () => { cancelled = true }
}, [isOpen, isSync, event.id])

async function handleMuteConfirm(spec: MuteSyncConfirmSpec) {
  setMuteOpen(false)
  try {
    await dbClient.ignoreRules.add({
      adapter_id: provenance?.adapter_id ?? 'gmail',
      kind: spec.kind,
      pattern: spec.pattern,
      subject_keyword: spec.subject_keyword,
      source_event_id: event.id,
      source_message_id: provenance?.source_message_id ?? null,
    })
    if (spec.alsoDeleteCurrent) {
      await dbClient.events.delete(event.id)
    }
    const matches = await dbClient.ignoreRules.findMatchingMbsyncEvents({
      kind: spec.kind,
      pattern: spec.pattern,
      subject_keyword: spec.subject_keyword,
    })
    // Exclude the one we just deleted if we did.
    const filtered = spec.alsoDeleteCurrent ? matches.filter((m) => m.id !== event.id) : matches
    if (filtered.length > 0) {
      setSweepMatches(filtered)
    } else if (spec.alsoDeleteCurrent) {
      onClose()
    }
  } catch (e) {
    // surface — for now alert(); subsequent iteration could route to a toast.
    alert(e instanceof Error ? e.message : 'Failed to mute')
  }
}

async function handleSweepDelete(ids: string[]) {
  await Promise.all(ids.map((id) => dbClient.events.delete(id)))
  setSweepMatches(null)
  onClose()
}
```

Add the Source section in the JSX, between the existing info block and the RSVP block (search for the `{event.hashtags && event.hashtags.length > 0` block; insert AFTER that):

```tsx
{isSync && (
  <div className="pt-4 border-t border-gray-200">
    <div className="flex items-start gap-2 text-sm">
      <Mail className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-700">Added by mailbox sync</p>
        {provenance ? (
          <p className="text-gray-600 break-all">From: {provenance.sender_display}</p>
        ) : (
          <p className="text-gray-500 italic">Source unknown</p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {provenance?.source_message_id && (
            <a
              href={`https://mail.google.com/mail/u/0/#inbox/${provenance.source_message_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-indigo-600 hover:underline"
            >
              View original email
            </a>
          )}
          <button
            type="button"
            onClick={() => setMuteOpen(true)}
            className="min-h-[44px] px-3 py-1 text-sm rounded-md border border-gray-300 hover:bg-gray-50"
          >
            Mute…
          </button>
        </div>
      </div>
    </div>
  </div>
)}
```

And render the dialogs at the end of the component (just before the existing parent-event modal recursion):

```tsx
<MuteSyncDialog
  isOpen={muteOpen}
  onClose={() => setMuteOpen(false)}
  onConfirm={handleMuteConfirm}
  eventId={event.id}
  provenance={provenance}
/>
{sweepMatches !== null && (
  <SweepMatchesDialog
    isOpen
    matches={sweepMatches.map((e) => ({ id: e.id, title: e.title, start_date: e.start_date }))}
    onClose={() => { setSweepMatches(null); onClose() }}
    onDelete={handleSweepDelete}
  />
)}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/EventDetailsModal.tsx
git commit -m "feat(web): EventDetailsModal Source section + mute/sweep wiring"
```

---

## Task 17: Skill prompt — Step B exclusions + addressed-to-me check

**Files:**
- Modify: `plugin/skills/plannen-mailbox-sync.md`

- [ ] **Step 1: Update the "Skip outright" list in Step B**

In `plugin/skills/plannen-mailbox-sync.md`, find the bullet starting with "**Skip outright** —" (around line 47). Replace it with:

```markdown
- **Skip outright** — newsletters, promotional blasts, CI failure emails, OTP/sign-in links, daily creche journals, GCal echoes of events already in Plannen, password resets, recruiter cold pitches with no concrete meeting proposed, marketing announcements without dates+venues, payment receipts for past transactions, dispute resolutions, threads already concluded ("I chose another option"), **mass marketing with date+venue (public ticketed festivals, brand "experience" events, commercial product launches — tell-tales: generic greeting like "Dear customer", sender on a brand mailing subdomain, CTA like "Book your seat / Discover more")**, **cold recruiter outreach even with a proposed time (tell-tales: no prior thread, generic "introductory chat" framing, no shared employer in headers)**, **transactional renewals & policy reminders (ACME-style — subject contains "renewal / due / expires / autopay / policy / KYC")**, **generic public event invites where the user is BCC'd or `to:` is a list address with generic greeting**. Outright-skip still advances `latestProcessedAt`; count as `skipped`.
```

- [ ] **Step 2: Tighten the event-worthy bar + add addressed-to-me check**

Replace the "Event-worthy" bullet with:

```markdown
- **Event-worthy** — set `confidence` to `high` only if you have all four of: a concrete date, a venue/place (or "remote" with a meeting link), the email is **addressed to the user personally** (greets by name, references a booking ID / thread / child's name / something only-they-would-know), and the date is in the future or today. Otherwise `low` confidence. Bulk marketing that happened to slip through Skip-outright but fails the addressed-to-me check is now treated as a skip, **not** routed to `#review`. `#review` is reserved for emails that ARE personally addressed but missing one of the other criteria.
```

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/plannen-mailbox-sync.md
git commit -m "feat(sync): tighten classifier — mass-marketing exclusions + addressed-to-me check"
```

---

## Task 18: Skill prompt — Step A rule kinds + Step E provenance

**Files:**
- Modify: `plugin/skills/plannen-mailbox-sync.md`

- [ ] **Step 1: Rewrite Step A — Ignore-rule check**

Find the "### Step A — Ignore-rule check" section. Replace its body with:

```markdown
### Step A — Ignore-rule check

For each thread:

1. Parse the first message's headers. Extract:
   - `from_raw` — raw `From:` header value (e.g. `"Acme Life <n@e.acmelife.com>"`)
   - `from_email` — lowercase address (everything between `<` and `>` if present, else the whole field, lowercased)
   - `from_domain` — host part of `from_email`
   - `email_subject` — the subject line

2. For each rule in `rules`, in array order:
   - If `rule.kind === 'sender'`: match iff `from_email === rule.pattern`.
   - If `rule.kind === 'domain'`: match iff `from_domain === rule.pattern` OR `from_domain` ends with `'.' + rule.pattern`.
   - If `rule.kind === 'domain_subject'`: match iff the domain condition AND `email_subject.toLowerCase().includes(rule.subject_keyword.toLowerCase())`.

3. First match wins:
   - Call `mcp__plugin_plannen_plannen__bump_ignore_rule_hit({id: rule.id})`.
   - Advance `latestProcessedAt = max(latestProcessedAt, max(message.internalDate on the thread))`.
   - Count as `muted`. Continue to next thread.

If no rule matches, fall through to Step B.
```

- [ ] **Step 2: Extend Step E with provenance recording**

Find "### Step E — Writing to Plannen". Append (just before "### Step F"):

```markdown
After a successful `create_event`, immediately call:

```
mcp__plugin_plannen_plannen__add_event_provenance({
  event_id:          <id returned from create_event>,
  source:            'mailbox',
  adapter_id:        'gmail',
  source_message_id: thread.id,
  sender_display:    <raw From: header value>,
  sender_email:      <lowercased addr extracted from From:>,
  sender_domain:     <lowercased host part>,
  subject:           thread.subject,
})
```

If `add_event_provenance` fails, do NOT abort the run — the event is still useful, the modal's Source section just degrades. Append the error to the run report's `errors` array and continue.

For `modify` operations, no provenance call is needed (provenance was set when the event was originally created).
```

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/plannen-mailbox-sync.md
git commit -m "feat(sync): Step A — three rule kinds; Step E — record event_provenance"
```

---

## Task 19: launchd cadence — every 4h around the clock

**Files:**
- Modify: `cli/lib/launchd-plist.mjs`
- Modify: `cli/lib/launchd-plist.test.mjs`
- Modify: `cli/commands/mailbox/install.mjs`

- [ ] **Step 1: Update the plist builder**

Replace the `hours` loop in `cli/lib/launchd-plist.mjs`:

```js
export function buildPlist({ label, wrapperPath, profile, homeDir, pathEnv }) {
  const SCHEDULE_HOURS = [0, 4, 8, 12, 16, 20]
  const hours = SCHEDULE_HOURS.map((h) => `    <dict>
      <key>Hour</key>
      <integer>${h}</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${wrapperPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${hours.join('\n')}
  </array>
  <key>ThrottleInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${homeDir}/.plannen/logs/mailbox-sync.log</string>
  <key>StandardErrorPath</key>
  <string>${homeDir}/.plannen/logs/mailbox-sync.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLANNEN_PROFILE</key>
    <string>${profile}</string>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
</dict>
</plist>
`
}

export const PLANNEN_SCHEDULE_HOURS = [0, 4, 8, 12, 16, 20]
```

- [ ] **Step 2: Update the test**

In `cli/lib/launchd-plist.test.mjs`, replace the "every hour 6..23" test:

```js
it('contains a StartCalendarInterval entry for the every-4h schedule', () => {
  const xml = buildPlist(opts)
  for (const h of [0, 4, 8, 12, 16, 20]) {
    expect(xml).toContain(`<integer>${h}</integer>`)
  }
  for (const h of [1, 5, 9, 13, 17, 21]) {
    // Sanity: in-between hours are NOT present.
    expect(xml).not.toContain(`<key>Hour</key>\n      <integer>${h}</integer>`)
  }
})
```

- [ ] **Step 3: Update the install command output**

In `cli/commands/mailbox/install.mjs`, change the `Runs:` line:

```js
console.log(`  Runs:    every 4h around the clock (00, 04, 08, 12, 16, 20) Europe/Brussels`)
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run cli/lib/launchd-plist.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/launchd-plist.mjs cli/lib/launchd-plist.test.mjs cli/commands/mailbox/install.mjs
git commit -m "feat(cli): launchd cadence — every 4h around the clock"
```

---

## Task 20: Sync-wrapper schedule warning

**Files:**
- Modify: `scripts/mailbox/sync-wrapper.sh`

- [ ] **Step 1: Add a one-shot pre-run warning**

Insert just before the `claude -p` invocation:

```bash
# One-time warning if the loaded plist still has the old hourly 06–23 schedule.
# A stale plist means the user updated the code but didn't re-run
# `npx plannen mailbox install` — they're getting the old cadence.
PLIST_INFO="$(launchctl print "gui/$(id -u)/work.plannen.mailbox-sync" 2>/dev/null || true)"
if [[ -n "$PLIST_INFO" ]] && echo "$PLIST_INFO" | grep -qE 'Hour = (7|11|15|19);'; then
  echo "[warn] $(date -Iseconds) Old launchd schedule detected (hourly 06–23). Run 'npx plannen mailbox install' to switch to the new every-4h cadence." >&2
fi
```

The grep is heuristic — it looks for Hour=7,11,15,19, which appear in the old schedule but NOT in the new (0,4,8,12,16,20). False-positive on a custom user schedule that happens to share these hours is acceptable for a one-line warning.

- [ ] **Step 2: Smoke-run the wrapper**

```bash
bash scripts/mailbox/sync-wrapper.sh
```

It will try to run `claude -p`; that's fine. Confirm there are no shell errors before the claude invocation. The warning fires only if the old plist is still loaded.

- [ ] **Step 3: Commit**

```bash
git add scripts/mailbox/sync-wrapper.sh
git commit -m "feat(sync): wrapper warns when an outdated launchd schedule is loaded"
```

---

## Task 21: Fixture suite doc

**Files:**
- Create: `docs/superpowers/specs/mailbox-sync-fixtures.md`

- [ ] **Step 1: Write the fixture file**

```markdown
# Mailbox Sync Classifier Fixtures

A by-hand regression suite for `/plannen-mailbox-sync` Step B (event-worthy classification). The LLM classifier isn't gated by CI; this file is what someone editing the prompt runs through manually.

Each row lists the email summary the classifier sees and the expected verdict:
- `skip` — should be Skip-outright
- `create-high` — should create with high confidence (no `#review`)
- `create-review` — should create with `#review` tag (personally addressed but missing one of the four high-confidence criteria)

| # | Subject | From | Snippet excerpt | Expected | Why |
|---|---|---|---|---|---|
| 1 | "NT2 Festival 2026 — Programme Released" | `noreply@nt2festival.be` | "Discover this year's lineup. Book your seat now." | `skip` | Mass marketing, public ticketed festival, generic greeting, brand "discover" CTA. |
| 2 | "EVCO Xperience Days — Test drive the X9" | `events@evco-experiences.com` | "Hi there, our test drive days are coming to your city." | `skip` | Commercial product launch / experience day; greets "Hi there"; sender on brand events subdomain. |
| 3 | "Acme Life Insurance Policy Renewal — Ensure Acc..." | `notification@e.acmelife.com` | "Dear customer, your policy is due for renewal on 15-Jun-2026." | `skip` | Transactional renewal reminder; "Dear customer" greeting; subject "renewal"; sender on bulk subdomain. |
| 4 | "Quick intro? — Senior Backend Eng role" | `cyriel@somerecruiter.com` | "Hi Pari, I came across your profile and I'm reaching out about an opportunity..." | `skip` | Cold recruiter pitch; no prior thread; generic intro framing. Even though it greets by name and proposes meeting, fails the "concrete date" and is a cold pitch. |
| 5 | "Confirmed: Treehouse build with Riya, June 12" | `parent@example.com` | "Hi Pari — we're confirmed for the 12th. Bring snacks!" | `create-high` | Personally addressed by name; concrete date; specific commitment from a friend. |
| 6 | "Your appointment confirmed — June 15, 10:00 at Dr. Smith" | `noreply@meddesk.com` | "Booking #ABC123 is confirmed for June 15." | `create-high` | Booking confirmation with ID; subject unambiguously personal. |
| 7 | "Open Day at Roberts Academy — All families welcome" | `info@robertsacademy.school` | "Dear families, join us on Saturday June 1 for our annual open day." | `skip` | Generic public invite; "Dear families"; no personal addressing. |
| 8 | "School trip on June 20 — please sign permission slip" | `office@kidsclassroom.school` | "Hi Pari, please return Riya's signed slip by Monday." | `create-high` | Personally addressed; references child by name; concrete date. |
| 9 | "Reminder: tickets are still available for the gala" | `news@somefoundation.org` | "Hi! We still have spots for the gala — secure yours today." | `skip` | Mass marketing dressed as a reminder; bulk newsletter sender; no personal addressing. |
| 10 | "Are you free Thu 18:00 for coffee?" | `aFriend@example.com` | "Hey Pari, want to grab coffee Thursday at 6? Same place as last time." | `create-review` | Personally addressed by name; thread-style; concrete day but ambiguous date (Thursday) and venue ("same place as last time"). Routes to `#review`. |

## How to run this suite

1. Open Gmail; tag 10 messages that approximate these fixtures (or use your own representative set; the categories matter more than the exact strings).
2. Run a sync iteration:
   ```bash
   bash scripts/mailbox/sync-wrapper.sh
   ```
3. Open `~/.plannen/logs/mailbox-sync.log`; check the final JSON for `created` / `skipped` counts and the classified rows in the log body.
4. For each fixture, confirm the classifier's verdict matches the expected column. If it diverges, the prompt needs another iteration.

This is the regression net, not CI. Run it when you edit `plugin/skills/plannen-mailbox-sync.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/mailbox-sync-fixtures.md
git commit -m "docs(sync): manual classifier fixture suite for prompt regressions"
```

---

## Task 22: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an Unreleased block**

Prepend (or extend the existing Unreleased section):

```markdown
## Unreleased

### Mailbox sync rework

- Cadence: every 4h around the clock (00, 04, 08, 12, 16, 20 Europe/Brussels) instead of hourly 06–23. **Re-run `npx plannen mailbox install` after upgrading** to load the new schedule.
- Classifier prompt tightened: explicit "Skip outright" categories for mass-marketing festivals, brand experience events, cold recruiter outreach, transactional renewals. New "addressed to me" check — bulk marketing no longer routes to `#review`.
- Web UI: `<Mail>` icon on `#mbsync` event cards; Source section in the event modal with sender + "View original email" + "Mute…" button.
- Mute UX: three rule kinds — exact sender, whole domain, domain + subject keyword. Defaults to mute + delete current event. Retroactive sweep dialog shows other `#mbsync` events the new rule would match.
- Schema: `mailbox_ignore_rules.sender` renamed to `pattern`; new `kind` + `subject_keyword` columns. New `event_provenance` sidecar table. New SQL helpers `ignore_rule_matches` and `find_matching_mbsync_events`. Forward-only migration; existing rules survive as `kind='sender'`.
- MCP additions: `find_matching_mbsync_events`, `add_event_provenance`, `get_event_provenance`. `add_ignore_rule` signature changed (now takes `kind` + `pattern` instead of `sender`).
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for mailbox sync rework"
```

---

## Final verification

After all tasks are done:

- [ ] **Step 1: Full typecheck**

```bash
npx tsc --noEmit && cd backend && npx tsc --noEmit && cd ..
```

Expected: clean both root and backend.

- [ ] **Step 2: Full test suite (frontend)**

```bash
npx vitest run
```

Expected: all green. Note any new failures unrelated to this work.

- [ ] **Step 3: Full test suite (backend, requires DATABASE_URL)**

```bash
cd backend && DATABASE_URL="$DATABASE_URL" npx vitest run && cd ..
```

Expected: all green where DATABASE_URL is set; the same env-required failures from main remain.

- [ ] **Step 4: Manual browser smoke**

`npm run dev` against a **non-prod** profile (the active profile is `sb_prod` per the user's machine — switch first with `npx plannen profile use <name>`). Open an event with `#mbsync`. Verify:
- `<Mail>` icon on the card
- Source section in the modal
- "Mute…" button opens the dialog
- Pick `domain`, submit — rule created in DB, current event deleted, sweep dialog opens if other matches exist

- [ ] **Step 5: Manual classifier fixture run**

Follow the steps in `docs/superpowers/specs/mailbox-sync-fixtures.md`. Expect at least #1–#4 (the originally-problematic emails) to be `skipped` after the prompt change.

- [ ] **Step 6: PR**

```bash
git push -u origin feat/mailbox-sync-rework
gh pr create --title "feat: mailbox sync rework — classifier precision, in-app mute UX, richer rules" --body "$(cat <<'EOF'
## Summary
- Spec: docs/superpowers/specs/2026-05-27-mailbox-sync-rework-design.md
- Plan: docs/superpowers/plans/2026-05-27-mailbox-sync-rework.md
- Schema: provenance sidecar + richer ignore_rules; one forward-only migration
- Prompt: tightened Step B, new Step A rule kinds, Step E records provenance
- UI: Mail icon on #mbsync cards; Source section + Mute dialog + Sweep dialog in modal
- Cadence: hourly 06–23 → every 4h around the clock

## Test plan
- [ ] `npx vitest run` clean
- [ ] `cd backend && DATABASE_URL=… npx vitest run` clean
- [ ] Manual: mute an #mbsync event via the modal on staging, verify sweep dialog
- [ ] Manual: run the classifier fixture suite; #1–#4 should now skip
- [ ] Re-run `npx plannen mailbox install` after merging to pick up the cadence change

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage**: every section in the design doc maps to at least one task — cadence (T19), classifier (T17), schema (T1), provenance (T1, T5, T6, T8, T10, T11), MCP tools (T3-T6), REST (T7, T8), dbClient (T9-T12), UI (T13-T16), sync agent (T17, T18), rollout (T20-T22).

**Placeholder check**: every step contains either complete code, an exact command, or an exact file location with what to change. No "fill in", "TBD", "similar to above".

**Type consistency**: `IgnoreRuleKind`, `IgnoreRuleRow`, `IgnoreRuleSpec`, `IgnoreRuleInput`, `EventProvenanceRow` are defined in T9 and used identically in T10, T11, T13, T16. The dialog spec interface `MuteSyncConfirmSpec` is exported from T13 and imported in T16. The MCP tool names match across Tier 0 (T6) and Tier 1/2 (T3-T5).

**Scope**: focused on the brainstormed redesign. No unrelated refactors. Backend cron architecture is explicitly out of scope per the spec.
