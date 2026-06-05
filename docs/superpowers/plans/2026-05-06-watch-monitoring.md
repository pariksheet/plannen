# Watch Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stub agent-monitor Edge Function with a Claude-driven watch system: three new MCP tools let Claude check watched events at session start, update event details when something changes, and surface an unread-update badge in the Plannen web app.

**Architecture:** `agent_tasks` gains six new columns to track check history, failure count, and unread updates. Three MCP tools (`get_event_watch_task`, `get_watch_queue`, `update_watch_task`) are added to `mcp/src/index.ts`. CLAUDE.md instructs Claude to call `get_watch_queue` at session start and run checks if anything is due. The web app reads watch state directly from `agent_tasks` via the Supabase JS client.

**Tech Stack:** TypeScript, Supabase (Postgres + JS client), React, MCP SDK (`@modelcontextprotocol/sdk`), date-fns

---

## File map

| File | Change |
|---|---|
| `supabase/migrations/028_agent_tasks_watch_columns.sql` | Create — new columns + unique index |
| `src/services/agentTaskService.ts` | Modify — add `getEventWatchTask`, `acknowledgeWatchUpdate` |
| `mcp/src/index.ts` | Modify — add 3 tool functions + register in TOOLS + switch |
| `CLAUDE.md` | Create — watch queue instruction |
| `src/components/WatchForNextYearButton.tsx` | Modify — persistent status on mount |
| `src/components/EventCard.tsx` | Modify — unread update badge |
| `src/components/EventDetailsModal.tsx` | Modify — acknowledge on open |
| `supabase/functions/agent-monitor/index.ts` | Delete |

---

### Task 1: DB migration — add watch columns to agent_tasks

**Files:**
- Create: `supabase/migrations/028_agent_tasks_watch_columns.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/028_agent_tasks_watch_columns.sql

ALTER TABLE public.agent_tasks
  ADD COLUMN IF NOT EXISTS last_checked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_result        JSONB,
  ADD COLUMN IF NOT EXISTS last_page_hash     TEXT,
  ADD COLUMN IF NOT EXISTS fail_count         INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_unread_update  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS update_summary     TEXT;

-- Required for agentTaskService upsert onConflict: 'event_id,task_type'
CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_event_id_task_type_key
  ON public.agent_tasks (event_id, task_type);
```

- [ ] **Step 2: Apply the migration**

```bash
supabase db push
```

Expected output: migration applied successfully (or "already applied" if running against remote).

If using local Supabase:
```bash
supabase migration up
```

- [ ] **Step 3: Verify columns exist**

```bash
supabase db diff --local
```

Or run in Supabase Studio SQL editor:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'agent_tasks'
ORDER BY ordinal_position;
```

Expected: `last_checked_at`, `last_result`, `last_page_hash`, `fail_count`, `has_unread_update`, `update_summary` appear in the list.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/028_agent_tasks_watch_columns.sql
git commit -m "feat: add watch monitoring columns to agent_tasks"
```

---

### Task 2: agentTaskService — helper functions for frontend

**Files:**
- Modify: `src/services/agentTaskService.ts`

Context: This file already has `createRecurringTask` and `createEnrollmentMonitorTask`. Add two more functions. The `supabase` client is already imported from `../lib/supabase`. The `agent_tasks` table columns added in Task 1 are now available.

- [ ] **Step 1: Add `getEventWatchTask` and `acknowledgeWatchUpdate`**

Open `src/services/agentTaskService.ts`. After the existing functions, add:

```ts
export interface WatchTask {
  id: string
  event_id: string
  task_type: string
  status: string
  next_check: string | null
  last_checked_at: string | null
  last_result: Record<string, unknown> | null
  fail_count: number
  has_unread_update: boolean
  update_summary: string | null
}

export async function getEventWatchTask(eventId: string): Promise<WatchTask | null> {
  const { data } = await supabase
    .from('agent_tasks')
    .select('id, event_id, task_type, status, next_check, last_checked_at, last_result, fail_count, has_unread_update, update_summary')
    .eq('event_id', eventId)
    .in('task_type', ['recurring_check', 'enrollment_monitor'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

export async function acknowledgeWatchUpdate(taskId: string): Promise<void> {
  await supabase
    .from('agent_tasks')
    .update({ has_unread_update: false })
    .eq('id', taskId)
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/agentTaskService.ts
git commit -m "feat: add getEventWatchTask and acknowledgeWatchUpdate"
```

---

### Task 3: MCP tools — get_event_watch_task, get_watch_queue, update_watch_task

**Files:**
- Modify: `mcp/src/index.ts`

Context: The MCP server is at `mcp/src/index.ts`. It has a `db` Supabase client (service role), a `uid()` helper, an array `TOOLS: Tool[]`, and a switch statement in the request handler. Tools are added in three places: the function implementation, the `TOOLS` array, and the `switch` case. Follow the existing pattern exactly.

- [ ] **Step 1: Add the three tool implementation functions**

Find the comment `// ── Tool registry ─────────────────` near line 504. Add these three functions directly above it:

```ts
// ── Watch monitoring tools ────────────────────────────────────────────────────

async function getEventWatchTask(args: { event_id: string }) {
  const id = await uid()
  const { data, error } = await db
    .from('agent_tasks')
    .select('id, event_id, task_type, status, next_check, last_checked_at, last_result, fail_count, has_unread_update, update_summary')
    .eq('event_id', args.event_id)
    .in('task_type', ['recurring_check', 'enrollment_monitor'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)

  // Verify the event belongs to this user
  if (data) {
    const { data: event, error: evErr } = await db
      .from('events')
      .select('id')
      .eq('id', data.event_id)
      .eq('created_by', id)
      .maybeSingle()
    if (evErr) throw new Error(evErr.message)
    if (!event) return null
  }
  return data ?? null
}

async function getWatchQueue() {
  const id = await uid()
  const now = new Date().toISOString()

  // Step 1: get IDs of all events owned by this user
  const { data: userEvents, error: evErr } = await db
    .from('events')
    .select('id, title, enrollment_url, start_date')
    .eq('created_by', id)
  if (evErr) throw new Error(evErr.message)
  const eventIds = (userEvents ?? []).map((e) => e.id)
  if (!eventIds.length) return []

  // Step 2: get due tasks for those events
  const { data, error } = await db
    .from('agent_tasks')
    .select('id, event_id, task_type, last_result, last_page_hash, last_checked_at')
    .in('task_type', ['recurring_check', 'enrollment_monitor'])
    .eq('status', 'active')
    .lte('next_check', now)
    .in('event_id', eventIds)
  if (error) throw new Error(error.message)

  const eventMap = new Map((userEvents ?? []).map((e) => [e.id, e]))
  return (data ?? []).map((task) => {
    const event = eventMap.get(task.event_id)
    return {
      id: task.id,
      event_id: task.event_id,
      event_title: event?.title ?? null,
      enrollment_url: event?.enrollment_url ?? null,
      start_date: event?.start_date ?? null,
      task_type: task.task_type,
      last_result: task.last_result,
      last_page_hash: task.last_page_hash,
      last_checked_at: task.last_checked_at,
    }
  })
}

async function updateWatchTask(args: {
  task_id: string
  last_result: Record<string, unknown>
  last_page_hash: string
  next_check: string
  fail_count: number
  has_unread_update: boolean
  update_summary?: string
  status?: 'active' | 'failed'
}) {
  const payload: Record<string, unknown> = {
    last_result: args.last_result,
    last_page_hash: args.last_page_hash,
    last_checked_at: new Date().toISOString(),
    next_check: args.next_check,
    fail_count: args.fail_count,
    has_unread_update: args.has_unread_update,
    updated_at: new Date().toISOString(),
  }
  if (args.update_summary !== undefined) payload.update_summary = args.update_summary
  if (args.status !== undefined) payload.status = args.status

  const { error } = await db
    .from('agent_tasks')
    .update(payload)
    .eq('id', args.task_id)
  if (error) throw new Error(error.message)
  return { success: true }
}
```

- [ ] **Step 2: Register the three tools in the TOOLS array**

Find the closing `]` of the `TOOLS` array (after the `list_locations` tool). Add before that closing bracket:

```ts
  {
    name: 'get_event_watch_task',
    description: 'Get the watch task for a specific event (if one exists). Returns task status, last checked time, and whether there is an unread update.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Plannen event UUID' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_watch_queue',
    description: 'Return all watched events due for checking (next_check <= now, status = active). Call this at session start to know if any events need checking. Returns empty array if nothing is due — stay silent in that case.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_watch_task',
    description: 'Save results after checking a watched event. Call this after fetching the enrollment URL and comparing to last_result. Set has_unread_update=true and update_summary when something changed. Compute next_check based on event proximity: >6 months → +7 days, 1-6 months → +2 days, <1 month → +1 day. Set status=failed and stop if fail_count reaches 3.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'agent_tasks UUID' },
        last_result: { type: 'object', description: 'Extracted details: { dates?, price?, enrollment_open?, deadline?, notes? }' },
        last_page_hash: { type: 'string', description: 'Short hash or fingerprint of page content for future diffing' },
        next_check: { type: 'string', description: 'ISO timestamp for next scheduled check' },
        fail_count: { type: 'number', description: 'Consecutive failure count (reset to 0 on success, increment on fetch error)' },
        has_unread_update: { type: 'boolean', description: 'Set true when content changed since last check' },
        update_summary: { type: 'string', description: 'Human-readable summary shown as badge (e.g. "Registration now open · €450/week")' },
        status: { type: 'string', enum: ['active', 'failed'], description: 'Set failed when fail_count reaches 3' },
      },
      required: ['task_id', 'last_result', 'last_page_hash', 'next_check', 'fail_count', 'has_unread_update'],
    },
  },
```

- [ ] **Step 3: Add switch cases**

In the `switch (name)` block, add after the `list_locations` case:

```ts
      case 'get_event_watch_task': result = await getEventWatchTask(args as Parameters<typeof getEventWatchTask>[0]); break
      case 'get_watch_queue':      result = await getWatchQueue(); break
      case 'update_watch_task':    result = await updateWatchTask(args as Parameters<typeof updateWatchTask>[0]); break
```

- [ ] **Step 4: Build the MCP server to verify no TypeScript errors**

```bash
cd mcp && npm run build
```

Expected: exits 0, `dist/index.js` updated.

- [ ] **Step 5: Smoke test the new tools**

Restart the plannen MCP server and run a quick test via Claude Code: ask Claude to call `get_watch_queue`. Expected: returns `[]` (no tasks due yet) without error.

- [ ] **Step 6: Commit**

```bash
cd ..
git add mcp/src/index.ts mcp/dist/
git commit -m "feat: add get_event_watch_task, get_watch_queue, update_watch_task MCP tools"
```

---

### Task 4: CLAUDE.md — watch queue instruction

**Files:**
- Create: `CLAUDE.md` (project root)

Context: CLAUDE.md is read by Claude Code at session start. This file does not exist yet. Keep it concise — one section for watch monitoring.

- [ ] **Step 1: Create CLAUDE.md**

```markdown
# Plannen — Claude Code Instructions

## Watch monitoring

At the start of every session, call `get_watch_queue`.

- If the result is an empty array: stay completely silent.
- If events are returned: for each one, fetch its `enrollment_url` using your web fetch capability, extract what you find (dates, price, whether registration is open, any deadline), and compare to `last_result`.
  - **If changed:** call `update_event` with the new details (dates, enrollment_url if new), then call `update_watch_task` with `has_unread_update: true` and an `update_summary` (e.g. "Registration now open · €450/week"). Tell the user what changed and suggest they set the event status if registration opened.
  - **If unchanged:** call `update_watch_task` with `has_unread_update: false` and advance `next_check`. Stay silent.
  - **If fetch fails:** increment `fail_count`. At 3 consecutive failures set `status: "failed"` and tell the user the page was unreachable.

The user can also say "check my watched events" at any time to force an immediate run regardless of `next_check`.
```

- [ ] **Step 2: Verify the file is at project root**

```bash
ls CLAUDE.md
```

Expected: file exists.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "feat: add CLAUDE.md with watch queue session-start instruction"
```

---

### Task 5: WatchForNextYearButton — persistent status on mount

**Files:**
- Modify: `src/components/WatchForNextYearButton.tsx`

Context: Currently the button creates an `agent_tasks` record but loses state on page reload — it always shows the button. After Task 1, the `agent_tasks` table has `last_checked_at`, `status`, and `has_unread_update`. After Task 2, `getEventWatchTask` is available in `agentTaskService`. This component should check for an existing task on mount and show the current watch status instead of the button.

- [ ] **Step 1: Rewrite WatchForNextYearButton**

Replace the entire file content with:

```tsx
import { useEffect, useState } from 'react'
import { Loader } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Event } from '../types/event'
import { createRecurringTask, getEventWatchTask, WatchTask } from '../services/agentTaskService'

export function WatchForNextYearButton({ event }: { event: Event }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [task, setTask] = useState<WatchTask | null>(null)

  useEffect(() => {
    if (!event.enrollment_url) { setLoading(false); return }
    getEventWatchTask(event.id).then((t) => {
      setTask(t)
      setLoading(false)
    })
  }, [event.id, event.enrollment_url])

  if (!event.enrollment_url) return null
  if (loading) return <span className="text-xs text-gray-400">Loading…</span>

  if (task) {
    if (task.status === 'failed') {
      return (
        <span className="text-xs text-red-600 font-medium">
          Watch failed — check manually
        </span>
      )
    }
    const lastChecked = task.last_checked_at
      ? `Last checked ${formatDistanceToNow(new Date(task.last_checked_at), { addSuffix: true })}`
      : 'Not yet checked'
    return (
      <span className="text-xs text-indigo-600 font-medium">
        Watching · {lastChecked}
      </span>
    )
  }

  const handleClick = async () => {
    setSaving(true)
    try {
      await createRecurringTask(event.id, event.enrollment_url!)
      const t = await getEventWatchTask(event.id)
      setTask(t)
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      disabled={saving}
      onClick={handleClick}
      className="inline-flex items-center min-h-[36px] px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
    >
      {saving ? <Loader className="h-4 w-4 animate-spin mr-2" /> : null}
      Watch for Next Occurrence
    </button>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If `formatDistanceToNow` is missing, it's already available — `date-fns` is in the project.

- [ ] **Step 3: Manual verification**

Start the dev server (`npm run dev`). Open an event that has an `enrollment_url` and a watch task in the DB. Verify: "Watching · Last checked X" appears instead of the button. Open an event without a watch task — the button should still show.

- [ ] **Step 4: Commit**

```bash
git add src/components/WatchForNextYearButton.tsx
git commit -m "feat: WatchForNextYearButton shows persistent watch status on load"
```

---

### Task 6: EventCard — unread update badge

**Files:**
- Modify: `src/components/EventCard.tsx`

Context: EventCard receives an `event: Event` prop. When an event has an active watch task with `has_unread_update: true`, show a small amber badge with the `update_summary` text. Fetch the task on mount, only if the event has an `enrollment_url` (the only events that can be watched). Both compact and detailed view modes should show the badge.

- [ ] **Step 1: Add watch task fetch to EventCard**

In `src/components/EventCard.tsx`, add the import at the top alongside existing imports:

```ts
import { useEffect, useState } from 'react'
import { getEventWatchTask, WatchTask } from '../services/agentTaskService'
```

Note: `useState` and `useEffect` may already be imported — if so, don't duplicate them. Merge with the existing React import line.

- [ ] **Step 2: Add state and effect inside the EventCard component**

Inside the `EventCard` function body, after the existing state declarations, add:

```ts
const [watchTask, setWatchTask] = useState<WatchTask | null>(null)

useEffect(() => {
  if (!event.enrollment_url) return
  getEventWatchTask(event.id).then(setWatchTask)
}, [event.id, event.enrollment_url])
```

- [ ] **Step 3: Add the badge JSX**

Create a badge element to reuse in both view modes:

```ts
const updateBadge = watchTask?.has_unread_update && watchTask.update_summary ? (
  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-200">
    {watchTask.update_summary}
  </span>
) : null
```

Place this after the `watchTask` state declarations. Then render `{updateBadge}` in an appropriate spot in both the compact and detailed card layouts — just below the event title works well in both cases.

Find the title rendering in both compact and detailed sections. The title is typically rendered as an `<h3>` or similar. Add `{updateBadge}` immediately after the title element in both branches.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Manual verification**

Using the Supabase Studio SQL editor or MCP, manually set `has_unread_update = true` and `update_summary = 'Registration now open · €450/week'` on an agent_tasks row. Reload the app. Verify the amber badge appears on the corresponding event card.

```sql
UPDATE agent_tasks
SET has_unread_update = true, update_summary = 'Registration now open · €450/week'
WHERE event_id = '<your-event-uuid>';
```

- [ ] **Step 6: Commit**

```bash
git add src/components/EventCard.tsx
git commit -m "feat: show unread update badge on EventCard when watch finds changes"
```

---

### Task 7: EventDetailsModal — acknowledge update on open

**Files:**
- Modify: `src/components/EventDetailsModal.tsx`

Context: When the user opens the EventDetailsModal for an event that has `has_unread_update: true`, clear the flag so the badge disappears on next render. Fetch the watch task on open, acknowledge if needed.

- [ ] **Step 1: Add imports and state**

In `src/components/EventDetailsModal.tsx`, add to existing imports:

```ts
import { useEffect } from 'react'
import { getEventWatchTask, acknowledgeWatchUpdate } from '../services/agentTaskService'
```

Note: if `useEffect` is already imported, don't duplicate it.

- [ ] **Step 2: Add acknowledge effect inside EventDetailsModal**

Inside the `EventDetailsModal` function body, add:

```ts
useEffect(() => {
  if (!isOpen || !event.enrollment_url) return
  getEventWatchTask(event.id).then((task) => {
    if (task?.has_unread_update) {
      acknowledgeWatchUpdate(task.id)
    }
  })
}, [isOpen, event.id, event.enrollment_url])
```

This runs when `isOpen` becomes true. It fetches the task and clears `has_unread_update` if set.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

With `has_unread_update = true` set from Task 6, open the event's details modal. Close it and reload the page. Verify the amber badge no longer appears (the flag was cleared).

- [ ] **Step 5: Commit**

```bash
git add src/components/EventDetailsModal.tsx
git commit -m "feat: acknowledge watch update when EventDetailsModal opens"
```

---

### Task 8: Delete the stub agent-monitor Edge Function

**Files:**
- Delete: `supabase/functions/agent-monitor/index.ts`

Context: The `agent-monitor` Edge Function was the old executor — it ran on a Supabase cron schedule but only had stub logic. Claude is now the executor. This file is no longer needed.

- [ ] **Step 1: Delete the file**

```bash
rm supabase/functions/agent-monitor/index.ts
```

Check if the directory is now empty:

```bash
ls supabase/functions/agent-monitor/
```

If empty, remove the directory:

```bash
rmdir supabase/functions/agent-monitor/
```

- [ ] **Step 2: Check nothing imports it**

```bash
grep -r "agent-monitor" src/ mcp/ --include="*.ts" --include="*.tsx"
```

Expected: no results.

- [ ] **Step 3: Commit**

```bash
git add -A supabase/functions/
git commit -m "chore: delete stub agent-monitor Edge Function (replaced by Claude-driven watching)"
```

---

### Task 9: End-to-end smoke test

No automated test framework exists in this project. Do a full manual walkthrough to confirm all pieces work together.

- [ ] **Step 1: Set up a test watch task**

Pick an event that has an `enrollment_url`. If none exists, create one via Claude Code: "Add an event called Test Watch with enrollment_url https://example.com". Then click "Watch for Next Occurrence" in the UI — confirm the button changes to "Watching · Not yet checked".

- [ ] **Step 2: Verify get_watch_queue returns the task**

In Claude Code, ask: "Call get_watch_queue and tell me what comes back."

Expected: either an empty array (because `next_check` is in the future) or the task if `next_check <= now`.

To force it due, run in Supabase Studio:
```sql
UPDATE agent_tasks SET next_check = NOW() - INTERVAL '1 minute', status = 'active'
WHERE task_type = 'recurring_check';
```

Then ask Claude again — it should return the task.

- [ ] **Step 3: Run a full check cycle**

Ask Claude: "Check my watched events now."

Expected sequence:
1. Claude calls `get_watch_queue` — gets the task
2. Claude fetches the `enrollment_url` with WebFetch
3. Claude compares to `last_result` (null first time = treat as changed)
4. Claude calls `update_event` if new details found
5. Claude calls `update_watch_task` with result
6. Claude reports what it found in the chat

- [ ] **Step 4: Verify the badge appears in Plannen**

If Claude set `has_unread_update = true`, reload the web app. The event card should show the amber update badge.

- [ ] **Step 5: Verify acknowledge works**

Open the event's details modal. Close it. Reload the page. The badge should be gone.

- [ ] **Step 6: Verify session-start behaviour**

Close and reopen Claude Code. If `next_check` is in the past, Claude should proactively report without being asked. If `next_check` is in the future, Claude should stay silent.
