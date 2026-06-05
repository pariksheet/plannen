# Watch Monitoring — Design

**Date:** 2026-05-06
**Status:** Approved

## Overview

Replace the stub `agent-monitor` Edge Function with a Claude-driven watch system. Claude checks watched events at session start (at most once per day per event), fetches enrollment URLs, extracts what changed, updates the event, and reports to the user. Plannen shows a badge on cards with unread updates.

## Architecture

### Core flow

1. User opens Claude Code with the plannen MCP server loaded
2. Claude calls `get_watch_queue` — returns tasks where `next_check <= now AND status = 'active'`
3. If queue is empty: stay silent
4. For each due event: Claude fetches `enrollment_url` via WebFetch, extracts dates/price/open status
5. Compare extracted content against `last_result` stored on the task
6. **If changed:**
   - Call `update_event` MCP tool with new details (dates, price, enrollment info)
   - Call `update_watch_task` with new result, `has_unread_update = true`, `update_summary`, new `next_check`
   - Tell user in chat: "Registration opened for [Event] — I've updated the event details. You may want to set the status to Enrolling."
7. **If unchanged:** call `update_watch_task` to advance `next_check`, stay silent
8. User can say "check my watched events" at any time for an immediate forced run

### `next_check` schedule

| Proximity to event | Interval |
|---|---|
| > 6 months away | +7 days |
| 1–6 months away | +2–3 days |
| < 1 month away | +1 day |
| Fetch failed | +1 hour, then +1 day |
| 3 consecutive failures | mark `status = 'failed'`, notify user |

### Failure handling

- Each failed fetch increments `fail_count`
- 3 consecutive failures → `status = 'failed'`, Claude tells user: "Could not reach [Event] page — you may want to check manually."
- Successful check resets `fail_count` to 0

## Database changes

### `agent_tasks` — new columns

| Column | Type | Description |
|---|---|---|
| `last_checked_at` | `TIMESTAMPTZ` | When Claude last ran a check |
| `last_result` | `JSONB` | Extracted details from last check (dates, price, open status) |
| `last_page_hash` | `TEXT` | Hash of page content for quick diffing |
| `fail_count` | `INT DEFAULT 0` | Consecutive fetch failures |
| `has_unread_update` | `BOOLEAN DEFAULT false` | Unacknowledged change found |
| `update_summary` | `TEXT` | Human-readable summary shown as badge text |

Existing columns kept: `id`, `event_id`, `task_type`, `status`, `next_check`, `metadata`.

## MCP tools (new)

### `get_event_watch_task`

Returns the `agent_tasks` record for a given event (if one exists). Used by `WatchForNextYearButton` and EventCard to read current watch status without a raw DB query from the frontend.

Parameters: `{ event_id: string }`

Response: the task record or `null`.

### `get_watch_queue`

Returns all `agent_tasks` where `next_check <= now AND status = 'active'`, joined with event title and `enrollment_url`.

Response shape:
```ts
{
  id: string
  event_id: string
  event_title: string
  enrollment_url: string
  task_type: 'recurring_check' | 'enrollment_monitor'
  last_result: Record<string, unknown> | null
  last_page_hash: string | null
  last_checked_at: string | null
}[]
```

### `update_watch_task`

Updates task state after Claude runs a check.

Parameters:
```ts
{
  task_id: string
  last_result: Record<string, unknown>
  last_page_hash: string
  next_check: string           // ISO timestamp
  fail_count: number
  has_unread_update: boolean
  update_summary?: string      // only set when has_unread_update = true
  status?: 'active' | 'failed' // only set when changing status
}
```

## CLAUDE.md addition

One instruction added to the plannen project CLAUDE.md:

> At the start of each session, call `get_watch_queue`. If events are returned, fetch each `enrollment_url`, extract dates/price/registration status, compare to `last_result`, and call `update_watch_task` with results. Report any changes to the user and update the event details via `update_event`. Stay silent if nothing is due or nothing changed.

## Plannen UI changes

### `WatchForNextYearButton`

On mount, check `agent_tasks` for an existing task for this event. If a task exists, show status instead of the button:

- `status = 'active'` → "Watching · last checked X days ago"
- `status = 'failed'` → "Watch failed — check manually" (with option to retry)
- No task → show "Watch for Next Occurrence" button (existing behaviour)

### EventCard / EventDetailsModal

If the event's `agent_tasks` record has `has_unread_update = true`, show a small badge on the card: the `update_summary` text (e.g. "Registration now open · €450/week").

When the user opens EventDetailsModal for an event with an unread update, acknowledge it: call `update_watch_task` to set `has_unread_update = false`.

## Files changed

| Action | File |
|---|---|
| Migration | `supabase/migrations/` — add columns to `agent_tasks` |
| Add MCP tool | `scripts/plannen-mcp/index.ts` — `get_event_watch_task` |
| Add MCP tool | `scripts/plannen-mcp/index.ts` — `get_watch_queue` |
| Add MCP tool | `scripts/plannen-mcp/index.ts` — `update_watch_task` |
| Modify | `CLAUDE.md` — add watch queue instruction |
| Modify | `src/components/WatchForNextYearButton.tsx` — persistent status |
| Modify | `src/components/EventCard.tsx` — unread update badge |
| Modify | `src/components/EventDetailsModal.tsx` — acknowledge on open |
| Delete | `supabase/functions/agent-monitor/index.ts` |
