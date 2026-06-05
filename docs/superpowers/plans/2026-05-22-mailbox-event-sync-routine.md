# Mailbox Event Sync Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hourly launchd routine that scans Gmail for event-worthy mail, classifies it, writes events/reminders to Plannen, and same-run syncs to Google Calendar. Single-sender mute via a new `mailbox_ignore_rules` table.

**Architecture:** A new slash command `/plannen-mailbox-sync` is invoked hourly by macOS launchd. The command loads a skill that walks Claude through pulling Gmail messages (excluding `plannen-ingested` + `plannen-ignore` labels), checking each against `mailbox_ignore_rules`, classifying via the active Claude session, matching against existing Plannen events, writing creates/updates/cancels through the Plannen MCP, then syncing to GCal. Rules + mute are managed via new MCP tools and a small web-UI prompt.

**Tech Stack:** TypeScript (MCP + tests) · Vitest · PostgreSQL + RLS · macOS launchd · bash · citty (CLI) · React/Astro (web UI) · existing claude.ai Gmail + Google Calendar MCPs · existing Plannen MCP.

---

## File Structure

**New files**
- `supabase/migrations/20260522180000_mailbox_ignore_rules.sql` — table + RLS.
- `mcp/src/mailboxIgnoreRules.ts` — pure helpers (matchRule, formatSender) plus SQL builders used by index.ts.
- `mcp/src/mailboxIgnoreRules.test.ts` — Vitest unit tests for the helpers.
- `plugin/skills/plannen-mailbox-sync.md` — the routine's instructional prompt (adapter contract, classification rules, matching logic, dismissal handling).
- `plugin/commands/plannen-mailbox-sync.md` — thin slash command that triggers the skill.
- `plugin/commands/plannen-mailbox-rules.md` — list/delete ignore rules interactively.
- `plugin/commands/plannen-mailbox-status.md` — show last-run summary.
- `scripts/mailbox/sync-wrapper.sh` — flock, log rotation, `claude -p` invocation, failure notification.
- `cli/commands/mailbox/install.mjs` — write & load launchd plist.
- `cli/commands/mailbox/uninstall.mjs` — unload & remove launchd plist.
- `cli/commands/mailbox/index.mjs` — citty subcommand router.
- `cli/lib/launchd-plist.mjs` — pure plist-template builder + tests.
- `cli/lib/launchd-plist.test.mjs` — Vitest tests for the builder.

**Modified files**
- `mcp/src/index.ts` — register 4 new MCP tools (`list_ignore_rules`, `add_ignore_rule`, `delete_ignore_rule`, `bump_ignore_rule_hit`).
- `cli/main.mjs` — register `mailbox` subcommand group.
- `src/<event-card>.tsx` (path TBD by grep in Task 11) — add "Mute this sender?" prompt after delete/cancel on routine-created events.
- `plugin/skills/plannen-core.md` — add a paragraph referencing the new skill so the agent loads it for mailbox-related questions.
- `CLAUDE.md` — one-line pointer to the new skill + launchd install verb.

---

## Task 1: Database migration — `mailbox_ignore_rules`

**Files:**
- Create: `supabase/migrations/20260522180000_mailbox_ignore_rules.sql`

- [ ] **Step 1: Write the migration**

```sql
-- mailbox_ignore_rules: per-user, per-adapter single-sender mute list.
-- Used by /plannen-mailbox-sync to skip senders the user dismissed.
-- One rule per (user, adapter, sender) — single-sender granularity by design;
-- subject patterns are out of scope for v1.

CREATE TABLE IF NOT EXISTS plannen.mailbox_ignore_rules (
  id                uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id           uuid NOT NULL REFERENCES plannen.users(id) ON DELETE CASCADE,
  adapter_id        text NOT NULL CHECK (length(adapter_id) > 0),
  sender            text NOT NULL CHECK (length(sender) > 0),
  source_event_id   uuid REFERENCES plannen.events(id) ON DELETE SET NULL,
  source_message_id text,
  reason            text,
  hit_count         int  NOT NULL DEFAULT 0,
  last_hit_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, adapter_id, sender)
);

CREATE INDEX IF NOT EXISTS idx_mailbox_ignore_rules_user
  ON plannen.mailbox_ignore_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_mailbox_ignore_rules_lookup
  ON plannen.mailbox_ignore_rules(user_id, adapter_id, sender);

ALTER TABLE plannen.mailbox_ignore_rules ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE plannen.mailbox_ignore_rules TO anon;
GRANT ALL ON TABLE plannen.mailbox_ignore_rules TO authenticated;
GRANT ALL ON TABLE plannen.mailbox_ignore_rules TO service_role;

DROP POLICY IF EXISTS "Users manage their own ignore rules"
  ON plannen.mailbox_ignore_rules;
CREATE POLICY "Users manage their own ignore rules"
  ON plannen.mailbox_ignore_rules
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

- [ ] **Step 2: Apply migration locally**

Run: `npx plannen migrate`
Expected: migration appears in the applied list, no error. Confirm with:

```bash
psql "$DATABASE_URL" -c "\d plannen.mailbox_ignore_rules"
```

Expected: table description shows the columns + indexes + RLS enabled.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260522180000_mailbox_ignore_rules.sql
git commit -m "feat(db): mailbox_ignore_rules table for single-sender mute"
```

---

## Task 2: Pure helpers for ignore-rule matching (TDD)

**Files:**
- Create: `mcp/src/mailboxIgnoreRules.ts`
- Test: `mcp/src/mailboxIgnoreRules.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// mcp/src/mailboxIgnoreRules.test.ts
import { describe, it, expect } from 'vitest'
import { normaliseSender, ruleMatches, type IgnoreRule } from './mailboxIgnoreRules.js'

describe('normaliseSender', () => {
  it('lowercases the address', () => {
    expect(normaliseSender('Noreply@Arenal.BE')).toBe('noreply@arenal.be')
  })
  it('strips display-name wrapping', () => {
    expect(normaliseSender('"Arenal" <noreply@arenal.be>')).toBe('noreply@arenal.be')
  })
  it('returns the raw input if no email is detectable', () => {
    expect(normaliseSender('weird-thing')).toBe('weird-thing')
  })
})

describe('ruleMatches', () => {
  const rule: IgnoreRule = {
    id: 'r1', user_id: 'u1', adapter_id: 'gmail',
    sender: 'noreply@arenal.be',
    source_event_id: null, source_message_id: null, reason: null,
    hit_count: 0, last_hit_at: null, created_at: '2026-05-22T00:00:00Z',
  }
  it('matches identical sender + adapter', () => {
    expect(ruleMatches(rule, { adapter_id: 'gmail', sender: 'noreply@arenal.be' })).toBe(true)
  })
  it('matches case-insensitively', () => {
    expect(ruleMatches(rule, { adapter_id: 'gmail', sender: 'NoReply@Arenal.be' })).toBe(true)
  })
  it('does not match different adapter', () => {
    expect(ruleMatches(rule, { adapter_id: 'icloud', sender: 'noreply@arenal.be' })).toBe(false)
  })
  it('does not match different sender', () => {
    expect(ruleMatches(rule, { adapter_id: 'gmail', sender: 'other@arenal.be' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run mcp/src/mailboxIgnoreRules.test.ts`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// mcp/src/mailboxIgnoreRules.ts
export type IgnoreRule = {
  id: string
  user_id: string
  adapter_id: string
  sender: string
  source_event_id: string | null
  source_message_id: string | null
  reason: string | null
  hit_count: number
  last_hit_at: string | null
  created_at: string
}

export function normaliseSender(raw: string): string {
  const m = raw.match(/<([^>]+)>/)
  const addr = (m ? m[1] : raw).trim().toLowerCase()
  return addr
}

export function ruleMatches(
  rule: Pick<IgnoreRule, 'adapter_id' | 'sender'>,
  candidate: { adapter_id: string; sender: string },
): boolean {
  if (rule.adapter_id !== candidate.adapter_id) return false
  return normaliseSender(rule.sender) === normaliseSender(candidate.sender)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run mcp/src/mailboxIgnoreRules.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/mailboxIgnoreRules.ts mcp/src/mailboxIgnoreRules.test.ts
git commit -m "feat(mcp): ignore-rule matching helpers"
```

---

## Task 3: MCP tool — `list_ignore_rules`

**Files:**
- Modify: `mcp/src/index.ts` (add tool definition + handler)

- [ ] **Step 1: Add the tool definition**

Locate the `tools` array in `mcp/src/index.ts` (the array passed to `ListToolsRequestSchema`'s handler). Append:

```ts
{
  name: 'list_ignore_rules',
  description: 'List the user\'s mailbox ignore rules. Used by /plannen-mailbox-sync to skip muted senders before classification.',
  inputSchema: {
    type: 'object',
    properties: {
      adapter_id: { type: 'string', description: 'Filter by adapter (e.g. "gmail"). Omit for all adapters.' },
    },
  },
}
```

- [ ] **Step 2: Add the handler case**

In the `CallToolRequestSchema` handler's switch, add:

```ts
case 'list_ignore_rules': {
  const adapterId = (args?.adapter_id as string | undefined) ?? null
  const userId = await uid()
  return await withUserContext(userId, async (client: PoolClient) => {
    const sql = adapterId
      ? `SELECT id, adapter_id, sender, source_event_id, source_message_id, reason,
                hit_count, last_hit_at, created_at
         FROM plannen.mailbox_ignore_rules
         WHERE user_id = $1 AND adapter_id = $2
         ORDER BY created_at DESC`
      : `SELECT id, adapter_id, sender, source_event_id, source_message_id, reason,
                hit_count, last_hit_at, created_at
         FROM plannen.mailbox_ignore_rules
         WHERE user_id = $1
         ORDER BY created_at DESC`
    const params = adapterId ? [userId, adapterId] : [userId]
    const { rows } = await client.query(sql, params)
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
  })
}
```

- [ ] **Step 3: Rebuild MCP and smoke-test**

```bash
cd mcp && npm run build && cd ..
node -e "
import('./mcp/dist/index.js').then(() => console.log('boot OK'))
" 2>&1 | head -5
```

Expected: prints `boot OK` (process will hang awaiting stdio — Ctrl+C is fine).

Then from a fresh Claude Code session call `list_ignore_rules` — expect `[]`.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): list_ignore_rules tool"
```

---

## Task 4: MCP tool — `add_ignore_rule`

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add the tool definition** (append to `tools`)

```ts
{
  name: 'add_ignore_rule',
  description: 'Add a single-sender mute rule. Future emails from this sender on this adapter are skipped by /plannen-mailbox-sync without LLM classification.',
  inputSchema: {
    type: 'object',
    required: ['adapter_id', 'sender'],
    properties: {
      adapter_id:      { type: 'string', description: '"gmail" today; "icloud"/"imap" once those adapters land.' },
      sender:          { type: 'string', description: 'Email address. Display-name wrappers are stripped server-side.' },
      source_event_id: { type: 'string', description: 'Optional — the Plannen event whose dismissal created this rule.' },
      source_message_id: { type: 'string', description: 'Optional — the originating message ID for audit.' },
      reason:          { type: 'string', description: 'Optional human note.' },
    },
  },
}
```

- [ ] **Step 2: Add the handler case** (in the switch)

```ts
case 'add_ignore_rule': {
  const adapterId = String(args?.adapter_id ?? '').trim()
  const senderRaw = String(args?.sender ?? '').trim()
  if (!adapterId) throw new Error('adapter_id required')
  if (!senderRaw) throw new Error('sender required')
  const { normaliseSender } = await import('./mailboxIgnoreRules.js')
  const sender = normaliseSender(senderRaw)
  const sourceEventId = (args?.source_event_id as string | undefined) ?? null
  const sourceMessageId = (args?.source_message_id as string | undefined) ?? null
  const reason = (args?.reason as string | undefined) ?? null
  const userId = await uid()
  return await withUserContext(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `INSERT INTO plannen.mailbox_ignore_rules
         (user_id, adapter_id, sender, source_event_id, source_message_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, adapter_id, sender) DO UPDATE
         SET source_event_id   = COALESCE(EXCLUDED.source_event_id,   plannen.mailbox_ignore_rules.source_event_id),
             source_message_id = COALESCE(EXCLUDED.source_message_id, plannen.mailbox_ignore_rules.source_message_id),
             reason            = COALESCE(EXCLUDED.reason,            plannen.mailbox_ignore_rules.reason)
       RETURNING id, adapter_id, sender, source_event_id, source_message_id, reason,
                 hit_count, last_hit_at, created_at`,
      [userId, adapterId, sender, sourceEventId, sourceMessageId, reason],
    )
    return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }] }
  })
}
```

- [ ] **Step 3: Rebuild and verify**

```bash
cd mcp && npm run build && cd ..
```

Then in a Claude Code session: call `add_ignore_rule({adapter_id:"gmail", sender:"test@example.com"})`, then `list_ignore_rules` — expect one row.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): add_ignore_rule tool"
```

---

## Task 5: MCP tool — `delete_ignore_rule`

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add the tool definition**

```ts
{
  name: 'delete_ignore_rule',
  description: 'Delete a single ignore rule by id. Used by /plannen-mailbox-rules to unmute a sender.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
}
```

- [ ] **Step 2: Add the handler case**

```ts
case 'delete_ignore_rule': {
  const id = String(args?.id ?? '').trim()
  if (!id) throw new Error('id required')
  const userId = await uid()
  return await withUserContext(userId, async (client: PoolClient) => {
    const { rowCount } = await client.query(
      `DELETE FROM plannen.mailbox_ignore_rules WHERE id = $1 AND user_id = $2`,
      [id, userId],
    )
    return { content: [{ type: 'text', text: JSON.stringify({ deleted: rowCount ?? 0 }) }] }
  })
}
```

- [ ] **Step 3: Rebuild and verify**

```bash
cd mcp && npm run build && cd ..
```

In a Claude Code session: add a rule, copy its id, call `delete_ignore_rule({id:"<that-id>"})`. Expect `{"deleted": 1}`. Repeat — expect `{"deleted": 0}`.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): delete_ignore_rule tool"
```

---

## Task 6: MCP tool — `bump_ignore_rule_hit`

**Files:**
- Modify: `mcp/src/index.ts`

- [ ] **Step 1: Add the tool definition**

```ts
{
  name: 'bump_ignore_rule_hit',
  description: 'Increment hit_count and set last_hit_at = now() for a rule. /plannen-mailbox-sync calls this each time a muted message is skipped.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
}
```

- [ ] **Step 2: Add the handler case**

```ts
case 'bump_ignore_rule_hit': {
  const id = String(args?.id ?? '').trim()
  if (!id) throw new Error('id required')
  const userId = await uid()
  return await withUserContext(userId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `UPDATE plannen.mailbox_ignore_rules
         SET hit_count = hit_count + 1, last_hit_at = now()
         WHERE id = $1 AND user_id = $2
       RETURNING id, hit_count, last_hit_at`,
      [id, userId],
    )
    if (rows.length === 0) throw new Error('rule not found')
    return { content: [{ type: 'text', text: JSON.stringify(rows[0]) }] }
  })
}
```

- [ ] **Step 3: Rebuild and verify**

```bash
cd mcp && npm run build && cd ..
```

In a Claude Code session: add a rule, call `bump_ignore_rule_hit({id})` twice. Final `list_ignore_rules` should show `hit_count: 2` with a recent `last_hit_at`.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp): bump_ignore_rule_hit tool"
```

---

## Task 7: Write the routine skill (`plannen-mailbox-sync`)

**Files:**
- Create: `plugin/skills/plannen-mailbox-sync.md`

- [ ] **Step 1: Write the skill file**

```markdown
---
description: Walks through one /plannen-mailbox-sync run — pull unprocessed mail from every enabled adapter, classify, write to Plannen, sync to GCal. Loaded by the /plannen-mailbox-sync slash command; do not invoke standalone.
---

# Plannen Mailbox Sync — Routine

You are executing one iteration of the mailbox sync routine. The user is not watching this run — you must finish or fail cleanly without prompting.

## Adapters

For v1 only Gmail is enabled. The adapter contract is:

| Capability | Gmail implementation |
|---|---|
| `list_unprocessed` | `mcp__claude_ai_Gmail__search_threads` with query `newer_than:7d -in:sent -in:draft -from:me -label:plannen-ingested -label:plannen-ignore`, `pageSize: 50`. |
| `fetch_body`       | `mcp__claude_ai_Gmail__get_thread` with `messageFormat: FULL_CONTENT`. |
| `mark_processed`   | `mcp__claude_ai_Gmail__label_thread` with label name `plannen-ingested`. Create the label via `create_label` if `list_labels` doesn't return it (only on first ever run). |
| `mark_ignored`     | `mcp__claude_ai_Gmail__label_thread` with `plannen-ignore`. Same one-time create-if-missing rule. |

Each message carries an implicit `adapter_id = "gmail"` through the whole pipeline.

## Pre-flight

1. Call `mcp__plugin_plannen_plannen__list_ignore_rules({adapter_id: "gmail"})` → keep the result in memory as `rules`. Index by `normaliseSender(rule.sender)` (lowercase + strip display name).

2. Call `mcp__claude_ai_Gmail__list_labels` once. If neither `plannen-ingested` nor `plannen-ignore` exist, create them via `create_label`. Remember their label IDs.

## Per-message pipeline

For each thread returned by `list_unprocessed`:

### Step A — Ignore-rule check

Compute `sender = normaliseSender(thread.messages[0].sender)`. If `rules` contains an entry with that sender:
- Call `bump_ignore_rule_hit({id: rule.id})`.
- Call `label_thread` to add `plannen-ingested` (so it stays out of future scans).
- Skip classification. Continue to next thread.

### Step B — Classification

Read the snippet + headers. Decide:

- **Skip outright** — newsletters, promotional blasts, CI failure emails, OTP/sign-in links, daily creche journals, GCal echoes of events already in Plannen, password resets, recruiter cold pitches with no concrete meeting proposed, marketing announcements without dates+venues, payment receipts for past transactions, dispute resolutions, threads already concluded ("I chose another option").

- **Skip but mark processed** — anything in the "skip outright" list still needs the `plannen-ingested` label so the next run doesn't reconsider it.

- **Event-worthy** — set `confidence` to `high` only if you have all four of: a concrete date, a venue/place (or "remote" with a meeting link), a sender that explicitly addresses the user, and the date is in the future or today. Otherwise `low`.

- **needs_body** — set to `true` and call `get_thread(FULL_CONTENT)` once if the snippet doesn't yield a date/venue but the subject suggests an event (ticket purchases, formal invitations, club notices). Cap at one body fetch per thread per run.

Decide `operation`:

- `create` — default; the email describes a new event/reminder.
- `modify` — email implies an existing event changed (rescheduled, room changed).
- `cancel` — email explicitly cancels something.

### Step C — Matching (only for `modify` / `cancel`)

Call `mcp__plugin_plannen_plannen__list_events({from_date: matchDate - 1d, to_date: matchDate + 1d, limit: 50})`.

Filter the returned events to those where `location` contains the hinted venue OR `description` mentions the hinted sender.

- **Exactly one match** → call `update_event` with the new fields; ensure `event_status` becomes `cancelled` for cancels; append `review` to hashtags (max 5 — if at cap, replace the oldest non-`mbsync` tag).
- **Zero matches** → degrade to `create` and add `review` (the email implied a prior event we couldn't find).
- **Multiple matches** → do not touch the originals. Create a new `review`-tagged event whose description starts with `Ambiguous match — check originals. Gmail-ID: <id>`.

### Step D — Writing to Plannen

For creates:

```
mcp__plugin_plannen_plannen__create_event({
  title, start_date (UTC `Z`, computed from Brussels-local time),
  end_date  (UTC `Z`, or omit),
  location, description (must start with `Gmail-ID: <thread.id>\n\n`),
  event_kind: "event" | "reminder",
  event_status: "going" | "interested" | "watching" | "cancelled",
  hashtags: [ ...up to 5; always include "mbsync"; include "review" when confidence=low ],
})
```

Timezone rule: always emit `Z`-suffixed UTC for `start_date`/`end_date`. Brussels in CEST = UTC+2; in CET = UTC+1.

### Step E — Mark processed

After a successful write (or a clean skip), label the source thread `plannen-ingested`.

If the write throws, do NOT label. The next run will retry.

## After the per-message loop

1. Call `mcp__plugin_plannen_plannen__get_gcal_sync_candidates`.
2. For each candidate, call `mcp__claude_ai_Google_Calendar__create_event` with `timeZone: candidate.gcal_timezone` and `startTime: candidate.gcal_start` (local datetime, no offset).
3. Call `mcp__plugin_plannen_plannen__set_gcal_event_id({event_id, gcal_event_id})` for each.

## Failure handling

- Wrap each adapter's `list_unprocessed` in a try block. On error: retry twice with `setTimeout(2000)` then `setTimeout(8000)`. After final failure, record the adapter name and move on. Do not write the `plannen-ingested` label on any of its messages.
- If `mcp__plugin_plannen_plannen__list_events` or `create_event` throws with a connection-style error, abort the run immediately. Do not label any messages this run.
- If the Plannen MCP returns a BYOK error (`no_provider_configured` / `invalid_api_key` / `rate_limited` / `provider_unavailable` / `model_unavailable`), abort and surface the error code in the final report.

## Final report

The final assistant message must be exactly one JSON object on a single line so the launchd wrapper can parse it for the failure notification path:

```
{"ok": true, "created": 3, "updated": 1, "cancelled": 0, "skipped": 38, "muted": 2, "gcal_synced": 3, "errors": []}
```

For failures:

```
{"ok": false, "created": 0, "updated": 0, "cancelled": 0, "skipped": 0, "muted": 0, "gcal_synced": 0, "errors": ["gmail.list_unprocessed: 503 after retries"]}
```

The wrapper script greps `"ok":\s*false` to decide whether to fire `osascript -e 'display notification'`.

## Do NOT

- Do not prompt the user. There is no user.
- Do not output anything other than the JSON report line.
- Do not call any web-search or web-fetch tools — classification works from email content alone.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/skills/plannen-mailbox-sync.md
git commit -m "feat(plugin): plannen-mailbox-sync skill"
```

---

## Task 8: Slash command — `/plannen-mailbox-sync`

**Files:**
- Create: `plugin/commands/plannen-mailbox-sync.md`

- [ ] **Step 1: Write the slash command file**

```markdown
---
description: Run one iteration of the mailbox→Plannen sync routine. Invoked by macOS launchd hourly; can also be run manually for debugging.
---

The user (or a launchd job acting on their behalf) has invoked `/plannen-mailbox-sync`.

Trigger the `plannen-mailbox-sync` skill and follow its instructions exactly. Output only the final JSON report line — no narration, no headings, no follow-up offers.
```

- [ ] **Step 2: Manual smoke-run**

From a Claude Code session in the project root:

```
/plannen-mailbox-sync
```

Expected: a single JSON line at the end, e.g. `{"ok": true, "created": 0, "updated": 0, ...}` because all current unread mail is already labelled `plannen-ingested` after the dry-run from the brainstorm session. (If this is the first ever run, the `created` count may be non-zero.) The Gmail account should now have `plannen-ingested` and `plannen-ignore` labels created.

- [ ] **Step 3: Commit**

```bash
git add plugin/commands/plannen-mailbox-sync.md
git commit -m "feat(plugin): /plannen-mailbox-sync slash command"
```

---

## Task 9: Slash command — `/plannen-mailbox-rules`

**Files:**
- Create: `plugin/commands/plannen-mailbox-rules.md`

- [ ] **Step 1: Write the slash command file**

```markdown
---
description: List and delete your mailbox ignore rules — the single-sender mutes that /plannen-mailbox-sync respects.
---

The user has invoked `/plannen-mailbox-rules`.

1. Call `mcp__plugin_plannen_plannen__list_ignore_rules` (no args — show all adapters).
2. Render a numbered table:

   ```
   #  Adapter  Sender                          Hits  Last hit       Created
   1  gmail    information@mailers.acmebank.bank.in   12    2026-05-21     2026-05-10
   2  gmail    google-pay-noreply@google.com           4    2026-05-22     2026-05-15
   ```

3. Ask: *"Delete any? Reply with numbers (e.g. `1, 2`) or `none`."*
4. On a numeric reply, call `mcp__plugin_plannen_plannen__delete_ignore_rule({id})` for each selected row, in parallel.
5. Confirm: *"Deleted N rule(s). The corresponding senders will be re-evaluated by the next sync run."*

If `list_ignore_rules` returns `[]`, say *"No ignore rules — every sender is currently in scope."* and stop.
```

- [ ] **Step 2: Smoke-test**

In a Claude Code session, add a rule manually via `add_ignore_rule`, then run `/plannen-mailbox-rules`, delete it, run the command again — expect the empty-state message.

- [ ] **Step 3: Commit**

```bash
git add plugin/commands/plannen-mailbox-rules.md
git commit -m "feat(plugin): /plannen-mailbox-rules command"
```

---

## Task 10: Slash command — `/plannen-mailbox-status`

**Files:**
- Create: `plugin/commands/plannen-mailbox-status.md`

- [ ] **Step 1: Write the slash command file**

```markdown
---
description: Show the last few /plannen-mailbox-sync runs — when they ran, what they did, any errors.
---

The user has invoked `/plannen-mailbox-status`.

1. Read the last ~200 lines of `~/.plannen/logs/mailbox-sync.log` via the Bash tool.
2. Parse out the JSON report lines (one per run).
3. Show the last 5 runs as a table:

   ```
   When                  ok  +created  ~updated  -cancelled  skipped  muted  gcal
   2026-05-22 17:00      ✓   2         0          0           41       1      2
   2026-05-22 16:00      ✓   0         0          0           18       0      0
   2026-05-22 15:00      ✗   —         —          —           —        —      —     gmail.list_unprocessed: 503
   ...
   ```

4. If the log file is missing or empty, say *"No runs logged yet — has `npx plannen mailbox install` been run?"*.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/commands/plannen-mailbox-status.md
git commit -m "feat(plugin): /plannen-mailbox-status command"
```

---

## Task 11: launchd plist builder (TDD)

**Files:**
- Create: `cli/lib/launchd-plist.mjs`
- Test: `cli/lib/launchd-plist.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// cli/lib/launchd-plist.test.mjs
import { describe, it, expect } from 'vitest'
import { buildPlist } from './launchd-plist.mjs'

describe('buildPlist', () => {
  const opts = {
    label: 'work.plannen.mailbox-sync',
    wrapperPath: '/Users/u/Music/plannen/scripts/mailbox/sync-wrapper.sh',
    profile: 'prod',
    homeDir: '/Users/u',
    pathEnv: '/usr/local/bin:/usr/bin:/bin',
  }
  it('contains a StartCalendarInterval entry for every hour 6..23', () => {
    const xml = buildPlist(opts)
    for (let h = 6; h <= 23; h++) {
      expect(xml).toContain(`<integer>${h}</integer>`)
    }
    // 18 hours * 1 (only Hour key per entry) — Minute is always 0 -> 18 zero integers
  })
  it('sets ThrottleInterval=3600', () => {
    expect(buildPlist(opts)).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>3600<\/integer>/)
  })
  it('uses the wrapper path as the only ProgramArgument with bash -lc', () => {
    const xml = buildPlist(opts)
    expect(xml).toContain('<string>/bin/bash</string>')
    expect(xml).toContain('<string>-lc</string>')
    expect(xml).toContain(opts.wrapperPath)
  })
  it('embeds PLANNEN_PROFILE and PATH', () => {
    const xml = buildPlist(opts)
    expect(xml).toContain('<key>PLANNEN_PROFILE</key>')
    expect(xml).toContain('<string>prod</string>')
    expect(xml).toContain('<key>PATH</key>')
    expect(xml).toContain(opts.pathEnv)
  })
  it('sets RunAtLoad=false', () => {
    expect(buildPlist(opts)).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest --config cli/vitest.config.mjs run cli/lib/launchd-plist.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// cli/lib/launchd-plist.mjs
export function buildPlist({ label, wrapperPath, profile, homeDir, pathEnv }) {
  const hours = []
  for (let h = 6; h <= 23; h++) {
    hours.push(`    <dict>
      <key>Hour</key>
      <integer>${h}</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>`)
  }
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --config cli/vitest.config.mjs run cli/lib/launchd-plist.test.mjs`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/launchd-plist.mjs cli/lib/launchd-plist.test.mjs
git commit -m "feat(cli): launchd plist builder"
```

---

## Task 12: Wrapper script — `scripts/mailbox/sync-wrapper.sh`

**Files:**
- Create: `scripts/mailbox/sync-wrapper.sh`

- [ ] **Step 1: Write the wrapper**

```bash
#!/usr/bin/env bash
# Wraps `claude -p "/plannen-mailbox-sync"` with:
#   - flock-based concurrency lock
#   - 7-day log rotation
#   - macOS notification on failure (non-zero exit or `"ok": false` in output)
#
# Designed to be invoked by launchd; safe to run manually.

set -uo pipefail

LOCK="/tmp/plannen-mailbox-sync.lock"
LOG_DIR="$HOME/.plannen/logs"
LOG="$LOG_DIR/mailbox-sync.log"
ERR="$LOG_DIR/mailbox-sync.err"

mkdir -p "$LOG_DIR"

# 7-day rotation: delete anything older than 7 days in the log dir.
find "$LOG_DIR" -type f -name 'mailbox-sync.*' -mtime +7 -delete 2>/dev/null || true

notify_failure() {
  local message="$1"
  /usr/bin/osascript -e "display notification \"$message\" with title \"Plannen mailbox sync\"" >/dev/null 2>&1 || true
}

(
  if ! flock -n 9; then
    # Previous run still alive — exit silently.
    exit 0
  fi

  echo "=== $(date -Iseconds) start ===" >> "$LOG"

  # Run the routine. Capture both streams.
  # Model pinned to Haiku 4.5 — cheap classifier, per spec §5.
  # Sonnet escalation on borderline-long-body is left as future work; if a run
  # consistently misclassifies modify/cancel cases, swap to claude-sonnet-4-6.
  OUTPUT="$(claude -p --model claude-haiku-4-5-20251001 "/plannen-mailbox-sync" 2>>"$ERR")"
  EXIT=$?

  echo "$OUTPUT" >> "$LOG"
  echo "=== $(date -Iseconds) end exit=$EXIT ===" >> "$LOG"

  # Parse the last JSON line for ok=false.
  LAST_JSON="$(echo "$OUTPUT" | grep -oE '\{"ok":\s*(true|false).*\}' | tail -1)"

  if [[ "$EXIT" -ne 0 ]]; then
    notify_failure "Routine exited $EXIT — see ~/.plannen/logs/mailbox-sync.err"
  elif [[ -n "$LAST_JSON" && "$LAST_JSON" == *'"ok": false'* ]]; then
    # Pull errors array as best-effort.
    ERR_SUMMARY="$(echo "$LAST_JSON" | sed -E 's/.*"errors":\[([^]]*)\].*/\1/' | tr -d '\\"')"
    notify_failure "Run reported failure: ${ERR_SUMMARY:-see logs}"
  fi
) 9>"$LOCK"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/mailbox/sync-wrapper.sh
```

- [ ] **Step 3: Smoke-test**

```bash
./scripts/mailbox/sync-wrapper.sh
cat ~/.plannen/logs/mailbox-sync.log | tail -5
```

Expected: a `=== ... start ===` line, a JSON line, a `=== ... end exit=0 ===` line, no notification fired.

- [ ] **Step 4: Commit**

```bash
git add scripts/mailbox/sync-wrapper.sh
git commit -m "feat(scripts): mailbox sync launchd wrapper"
```

---

## Task 13: CLI verb — `npx plannen mailbox install`

**Files:**
- Create: `cli/commands/mailbox/install.mjs`
- Create: `cli/commands/mailbox/uninstall.mjs`
- Create: `cli/commands/mailbox/index.mjs`
- Modify: `cli/main.mjs` (register the `mailbox` subcommand group)

- [ ] **Step 1: Inspect `cli/main.mjs` for the registration pattern**

Run: `cat cli/main.mjs | head -60`

Look for the citty subcommand registration block. Note the import + `subCommands` shape — replicate it for `mailbox`.

- [ ] **Step 2: Write the subcommand router**

```js
// cli/commands/mailbox/index.mjs
import { defineCommand } from 'citty'
import install from './install.mjs'
import uninstall from './uninstall.mjs'

export default defineCommand({
  meta: { name: 'mailbox', description: 'Manage the mailbox-sync launchd job.' },
  subCommands: { install, uninstall },
})
```

- [ ] **Step 3: Write the install command**

```js
// cli/commands/mailbox/install.mjs
import { defineCommand } from 'citty'
import { writeFile, mkdir, chmod, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildPlist } from '../../lib/launchd-plist.mjs'

export default defineCommand({
  meta: { name: 'install', description: 'Write & load the launchd plist for /plannen-mailbox-sync.' },
  args: {
    profile: { type: 'string', description: 'Plannen profile name to run under (default: $PLANNEN_PROFILE or "default").' },
  },
  async run({ args }) {
    const home = homedir()
    const label = 'work.plannen.mailbox-sync'
    const plistDir = join(home, 'Library', 'LaunchAgents')
    const plistPath = join(plistDir, `${label}.plist`)
    const repoRoot = process.cwd()
    const wrapperPath = join(repoRoot, 'scripts', 'mailbox', 'sync-wrapper.sh')
    const profile = args.profile || process.env.PLANNEN_PROFILE || 'default'

    if (!existsSync(wrapperPath)) {
      console.error(`Wrapper script not found at ${wrapperPath} — run from the project root.`)
      process.exit(1)
    }

    await mkdir(plistDir, { recursive: true })
    await mkdir(join(home, '.plannen', 'logs'), { recursive: true })

    const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
    const xml = buildPlist({ label, wrapperPath, profile, homeDir: home, pathEnv })
    await writeFile(plistPath, xml, 'utf8')
    await chmod(wrapperPath, 0o755)

    // Reload: bootout first if already loaded, then bootstrap.
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`])
    const boot = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { encoding: 'utf8' })
    if (boot.status !== 0) {
      console.error('launchctl bootstrap failed:')
      console.error(boot.stderr || boot.stdout)
      process.exit(1)
    }

    console.log(`Installed launchd job '${label}'`)
    console.log(`  Plist:   ${plistPath}`)
    console.log(`  Wrapper: ${wrapperPath}`)
    console.log(`  Profile: ${profile}`)
    console.log(`  Runs:    hourly 06:00–23:00 Europe/Brussels`)
    console.log(`  Logs:    ${join(home, '.plannen', 'logs', 'mailbox-sync.log')}`)
    console.log(`Run 'npx plannen mailbox uninstall' to remove.`)
  },
})
```

- [ ] **Step 4: Write the uninstall command**

```js
// cli/commands/mailbox/uninstall.mjs
import { defineCommand } from 'citty'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export default defineCommand({
  meta: { name: 'uninstall', description: 'Stop and remove the launchd plist.' },
  async run() {
    const home = homedir()
    const label = 'work.plannen.mailbox-sync'
    const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`)

    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`])
    if (existsSync(plistPath)) {
      await unlink(plistPath)
      console.log(`Removed ${plistPath}`)
    } else {
      console.log(`No plist found at ${plistPath} — nothing to remove.`)
    }
  },
})
```

- [ ] **Step 5: Register in `cli/main.mjs`**

Open `cli/main.mjs`, find the `subCommands` object that lists existing verbs (`up`, `down`, `init`, etc.), and add:

```js
import mailbox from './commands/mailbox/index.mjs'
// ...
subCommands: {
  // ...existing entries...
  mailbox,
},
```

- [ ] **Step 6: Smoke-test**

```bash
npx plannen mailbox install --profile prod
launchctl list | grep work.plannen.mailbox-sync
cat ~/Library/LaunchAgents/work.plannen.mailbox-sync.plist | head -20
```

Expected: `launchctl list` returns one line containing the label, the plist exists with the expected XML.

Now force a single run to verify wiring:

```bash
launchctl kickstart -k gui/$(id -u)/work.plannen.mailbox-sync
sleep 5
tail ~/.plannen/logs/mailbox-sync.log
```

Expected: a fresh `=== start === ... === end exit=0 ===` block, a JSON line, no notification fired.

Then:

```bash
npx plannen mailbox uninstall
launchctl list | grep work.plannen.mailbox-sync || echo "removed"
```

Expected: `removed`.

- [ ] **Step 7: Commit**

```bash
git add cli/commands/mailbox/ cli/main.mjs
git commit -m "feat(cli): plannen mailbox install/uninstall"
```

---

## Task 14: Update plannen-core skill + CLAUDE.md to advertise the new surface

**Files:**
- Modify: `plugin/skills/plannen-core.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a pointer in `plannen-core.md`**

Open `plugin/skills/plannen-core.md`. Below the "Source analysis (auto-trigger)" section, add:

```markdown
## Mailbox sync

A separate launchd job runs `/plannen-mailbox-sync` hourly to ingest event-worthy mail from the user's mailboxes. You normally don't trigger it manually — but when the user asks about mute rules, dismissed senders, or run history, route them to `/plannen-mailbox-rules` and `/plannen-mailbox-status` rather than reading the rules table directly.

Install/uninstall lives in `npx plannen mailbox install|uninstall`.
```

- [ ] **Step 2: Add one line to `CLAUDE.md`**

In the `## Pointers` section of `/Users/stroomnova/Music/plannen/CLAUDE.md`, add:

```markdown
- Mailbox sync: launchd job at `~/Library/LaunchAgents/work.plannen.mailbox-sync.plist`. Logs at `~/.plannen/logs/mailbox-sync.log`. Manage via `npx plannen mailbox {install,uninstall}` and `/plannen-mailbox-rules`.
```

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/plannen-core.md CLAUDE.md
git commit -m "docs: advertise /plannen-mailbox-sync in core skill + CLAUDE.md"
```

---

## Task 15: Web UI — "Mute this sender?" prompt on dismissal

**Files:**
- Modify: the event-detail / event-card delete handler in the web app (path resolved in Step 1)

- [ ] **Step 1: Locate the event delete handler**

```bash
grep -rn "delete_event\|deleteEvent\|onDelete\|cancelEvent" src/ 2>/dev/null | head -20
```

Identify the React component that handles event deletion or cancellation. Typically named like `src/components/EventCard.tsx`, `src/routes/event/[id].tsx`, or similar. Note the exact path — you'll use it in steps below.

- [ ] **Step 2: Identify routine-created events**

A routine-created event is recognised by:

- `hashtags` includes `"mbsync"`, OR
- `description` starts with the prefix `Gmail-ID: `.

Add a helper near the delete handler:

```ts
function isRoutineCreated(event: { hashtags?: string[] | null; description?: string | null }): {
  routine: boolean
  sender?: string
} {
  const routine =
    (event.hashtags?.includes('mbsync') ?? false) ||
    (event.description?.startsWith('Gmail-ID: ') ?? false)
  if (!routine) return { routine: false }
  // Try to extract the source sender from the description first line.
  // Description shape: `Gmail-ID: <id>\n\n<original body or summary>`.
  // We don't store sender directly; the dialog will look it up via the Gmail thread.
  return { routine: true }
}
```

- [ ] **Step 3: Add the dismissal-prompt dialog**

After the existing delete-confirm dialog resolves with "yes, delete", and the event was routine-created, show a follow-up dialog. Use whichever modal/dialog primitive the project already uses (search existing code for `<Dialog`, `<AlertDialog`, `confirm(`).

The dialog asks:

> *Dismissed. Mute future emails from `<sender>`?*  
> **[Just this one] [Mute this sender]**

Resolving the sender:
- Extract the Gmail thread ID from the description (`description.split('\n', 1)[0].slice('Gmail-ID: '.length)`).
- Call the Gmail thread lookup. (If the project does not have a server-side Gmail wrapper, defer this to the user — show "Mute this sender? (paste sender email)" as a text input — keep the v1 implementation simple.)

On "Mute this sender":

```ts
await fetch('/api/mailbox-rules', {
  method: 'POST',
  body: JSON.stringify({ adapter_id: 'gmail', sender, source_event_id: event.id }),
})
```

If no `/api/mailbox-rules` endpoint exists yet, add it as a thin server route that calls the Plannen DB directly using the existing Supabase client (same pattern as other event mutations in the codebase). The endpoint translates to an `INSERT ... ON CONFLICT DO UPDATE` on `mailbox_ignore_rules`.

- [ ] **Step 4: Smoke-test in the browser**

```bash
npx plannen up
```

Open `http://localhost:4321`, find an event with `#mbsync` tag, delete it, confirm, choose "Mute this sender", refresh, run `/plannen-mailbox-rules` in a Claude session — the rule should appear.

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "feat(web): mute-sender dialog on dismissal of routine-created events"
```

---

## Task 16: End-to-end smoke test

**Files:** None — manual verification.

- [ ] **Step 1: Reset to known state**

In Gmail, remove the `plannen-ingested` label from 1-2 recent event-worthy threads (e.g. an Arenal booking confirmation) so the routine sees them as new.

- [ ] **Step 2: Force a run**

```bash
launchctl kickstart -k gui/$(id -u)/work.plannen.mailbox-sync
sleep 8
tail -20 ~/.plannen/logs/mailbox-sync.log
```

Expected: a JSON line with `"ok": true` and `"created"` > 0; the source threads now have `plannen-ingested`; the new events appear in Plannen with `#mbsync` hashtags; GCal has corresponding events.

- [ ] **Step 3: Force a muted-sender scenario**

Add a rule via `add_ignore_rule` for one of the senders. Remove the `plannen-ingested` label from one of that sender's threads. Kickstart again.

Expected: routine logs show that thread was skipped (counted in `"muted"` rather than `"created"`); the thread now has `plannen-ingested` so it doesn't reappear; `bump_ignore_rule_hit` updated the rule's `hit_count`.

- [ ] **Step 4: Force a failure scenario**

Temporarily revoke Gmail access (or set an invalid token in claude.ai if accessible). Kickstart. Expect a macOS notification "Plannen mailbox sync — Run reported failure" and the JSON line shows `"ok": false`. Restore Gmail access.

- [ ] **Step 5: Verify cleanup**

```bash
npx plannen mailbox uninstall
launchctl list | grep work.plannen.mailbox-sync && echo "STILL THERE" || echo "removed"
```

Expected: `removed`.

Re-install before signing off:

```bash
npx plannen mailbox install --profile prod
```

- [ ] **Step 6: Commit no-op marker (optional)**

If any minor docs cleanup surfaced during the smoke test, commit it here. Otherwise skip.

---

## Self-review notes (for the executor)

- The spec's three-layer dismissal architecture (UI → rules table → Gmail label) maps to tasks 1–6 (table + tools), task 7 step E + step A (routine respects the label *and* the rules table), and task 15 (UI).
- The "low-confidence ⇒ `#review`" rule is enforced in task 7, step B → step D.
- Timezone correctness (the bug observed in the brainstorm session — naive timestamps stored as UTC) is enforced in task 7, step D's "Timezone rule" paragraph.
- Single-sender mute (no subject patterns) is locked in by the table schema (task 1) and the `ruleMatches` helper (task 2).
- The `mbsync` hashtag is the marker that lets the UI know an event was routine-created (task 15) and lets the user filter for them in the Plannen feed.
- Future adapters slot in without touching the core: task 7's adapter table grows new rows, MCP tools and DB schema are already adapter-agnostic via `adapter_id`.
