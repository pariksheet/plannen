# To-do event type — design

**Date:** 2026-06-09
**Status:** Approved (design); pending implementation plan

## Problem / gap

Plannen has three kinds of "things on a date":

| Concept | One-off? | Has a date? | Has a "done" checkbox? | Shows in Timeline/Calendar? |
|---|---|---|---|---|
| Event (`event_kind:'event'`) | yes | required | no (ages into "past") | yes |
| Reminder (`event_kind:'reminder'`) | yes | required | no (ages into "past") | yes |
| Practice / Routine | no (recurring only) | no (recurs) | yes (per-date, `practice_completions`) | no (Schedule view only) |

The unfilled need is a **dated, checkable, one-off item** — "renew the passport", "pay the invoice", "call the school back". A reminder is the closest existing thing but has no sense of "done": it silently ages into the past whether or not the action happened. A practice has the checkbox but is structurally recurring and never appears in Timeline/Calendar.

`todo` fills that single empty cell: a one-off item you explicitly tick off, visible in all three views.

## Mental model: todo vs reminder

The litmus test is one question: **can you *finish* it by doing something?**

- **Reminder** = something to be *aware of* at a time. It occurs; you don't complete it. Passive. ("Bin day Tuesday.")
- **Todo** = something you must *do*, then tick off. You own the action; it has a binary outstanding→done state. ("Renew the passport.")

The **checkbox** is the defining affordance — nothing else in Plannen has a tickable box in the Timeline/Calendar/Schedule views, so its presence reads instantly as "this is mine to do."

## Decisions

1. **Distinct event_kind.** `todo` is its own `event_kind`, alongside `event` / `reminder` / `session`. Reminders stay purely passive; todos get the checkbox. Keeps the calendar legend clean (blue = event, green = reminder, amber = todo).
2. **Full datetime, like an event.** A todo always carries a `start_date` (datetime), exactly like an event/reminder. No date-schema change — `start_date` is already required. This is what makes a todo placeable in all three time-ordered views.
3. **Completed = strikethrough + dim, in place.** Checked box, title struck through, card dimmed, stays in its time slot. Matches the existing "dim the past" pattern; nothing vanishes, so the calendar/timeline stay stable.
4. **Overdue = stays put, flagged.** A todo whose datetime has passed but is still unchecked remains in its slot with a red/amber "overdue" tag. Completion is kept **separate from the `event_status` auto-resolver**, so an unfinished todo never silently becomes "past/missed".
5. **`assigned_to` defaults to the creator.** The column is added now (forward-compatible), but phase 1 always sets it to `created_by`. No assignment-to-others UI yet.
6. **User-initiated convert, no auto-migration.** Existing reminders stay reminders (auto-converting would slap an unchecked box on every past "bin day" nudge). A kebab action lets the user convert a single card between to-do and reminder.
7. **Lean card, like a reminder.** Todos hide RSVP / enrollment / attendees / memories. The added surface is the checkbox + overdue tag.

## Data model

One additive, forward-only migration under `supabase/migrations/`:

- Extend the `event_kind` CHECK to `'event' | 'reminder' | 'session' | 'todo'`.
- Add `completed_at TIMESTAMPTZ NULL` — `NULL` = open, timestamp = done.
- Add `assigned_to UUID NULL` — phase 1 the app sets it to `created_by` on creation.
- Update the `event_kind` column comment to document `todo`.

No new table. Completion is one-off, so a single `completed_at` column suffices — unlike practices, which need a per-date `practice_completions` table because they recur.

Tier 0 overlay (`supabase/migrations-tier0/`) needs no change — this touches neither `auth.*`, `storage.*`, nor roles.

### Derived states (no extra storage)

- **Open**: `completed_at IS NULL`
- **Done**: `completed_at` set
- **Overdue**: `completed_at IS NULL AND start_date < now()`

`event_status` is left untouched for todos; the auto-resolver (`resolveEventStatus`) must skip `event_kind === 'todo'` so a todo never auto-flips to `missed`/`past`.

## Types

`src/types/event.ts`:

- `EventKind` gains `'todo'`.
- `Event` interface gains `completed_at: string | null` and `assigned_to: string | null`.
- `resolveEventStatus` guards: return early / unchanged for todos (completion is orthogonal to `event_status`).

## MCP tools — both implementations (parity enforced)

Per the repo hard rule, every change lands in **both** `mcp/src/index.ts` (Tier 0 stdio) and `supabase/functions/mcp/tools/events.ts` (Tier 1/2 edge), and new tools are registered in the `TOOLS` array in `supabase/functions/mcp/index.ts`.

- `create_event`: add `'todo'` to the `event_kind` enum; accept optional `assigned_to` (defaults to creator server-side).
- New `complete_todo`: takes event id + optional `completed_at` (defaults to now); sets `completed_at`.
- New `uncomplete_todo`: takes event id; clears `completed_at`.
- Convert is handled by the existing `update_event` (flip `event_kind`; clear `completed_at` when converting back to reminder).
- `node scripts/check-mcp-parity.mjs` must pass (runs in CI / `npm run test:cli`).

## Frontend — reuse `EventCard`, touch all three views

The UI talks to Supabase directly via services; the MCP tools above are the agent's parallel surface.

- **`src/services/eventService.ts`**: `completeTodo(id)` / `uncompleteTodo(id)` and `convertEventKind(id, kind)`.
- **`EventCard.tsx`**: detect `isTodo`; render a leading checkbox in both compact and detailed view modes; checked → strikethrough title + dimmed card; derive and show an "overdue" tag; hide RSVP / enrollment / attendees / memories (as for reminders); add kebab actions "Convert to to-do" / "Convert to reminder".
- **`CalendarGrid.tsx`**: a third dot color (amber) for todos + a legend entry; completed todos rendered dimmed.
- **`Timeline.tsx`**: todos render inline via `EventCard` (compact), time-ordered with events/reminders; completed dimmed.
- **`ScheduleOverview.tsx` / WeekCard**: todos appear as agenda rows with an inline-tickable checkbox.
- **Event create/edit form**: add "To-do" to the kind selector; `assigned_to` is hidden and defaulted in phase 1.

## Testing

- `resolveEventStatus` leaves `event_kind === 'todo'` untouched (no auto `missed`/`past`).
- Overdue derivation: `completed_at IS NULL && start_date < now`.
- `EventCard` renders the checkbox; checked state applies strikethrough + dim.
- Calendar renders the amber todo dot and legend entry.
- Convert flips `event_kind` and clears `completed_at` when going back to reminder.
- MCP parity test green; `complete_todo` / `uncomplete_todo` present in both servers.

## Out of scope (phase 1)

- Assigning todos to other users / family members (defaults to creator).
- Recurring todos.
- Sub-tasks / checklists within a todo.
- Undated / pure-checklist todos.

All of the above remain forward-compatible with the `assigned_to` column added now.
