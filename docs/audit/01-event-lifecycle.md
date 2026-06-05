# Audit 01 — Event Lifecycle

## Summary

The event lifecycle UI is **mostly functional but has several real bugs and a swath of v0 REST features that are silently no-ops**. Create/edit/delete all reach real backend handlers; the date-handling utilities are local-time and consistent across components; and `Tier 0` (Plannen API via Vite proxy) and `Tier 1` (Supabase) both route through a unified `dbClient` contract. The three biggest concerns are:

1. **Visit-date side-effect on RSVP** (`rsvpService.setPreferredVisitDate`) — setting a visit date when no RSVP exists silently writes `status='maybe'`. `EventForm` then triggers this for every new/edited event that has a visit date, generating spurious RSVPs.
2. **Sharing for `selected` friends and groups is wired to silent no-ops** in the Tier-0 REST contract. `EventForm` shows the FriendPicker/GroupPicker UI, but `getMyFriends`/`getMyGroups` return only IDs (no names), `setEventSharedWithGroups` is a no-op, and the `selected` user list is never persisted (`eventService:108-111`). Users can configure sharing that does nothing.
3. **"Watch for next occurrence" checkbox is non-destructive on edit** — unchecking it on an already-watching event does not exit watching state; only the `convertFromWatching` checkbox actually changes status. The first checkbox is effectively a write-only signal and leaves stale watch tasks alive.

Beyond those: `RSVPList` always renders "No RSVPs yet." because `getRsvpList` is a stub returning empty buckets, and the `kebab` calendar-export menu in `EventCard`'s detailed view is rendered as a portal but does not toggle visibility correctly (`showKebabMenu` is shared across both compact and detailed kebabs and triggers from a single `kebabTriggerRef`/`kebabMenuRef`, causing UX issues when the same card mounts both render paths). Date handling is local-time across the board (no timezone toggle, no all-day flag) — acceptable for a single-user app but worth flagging.

## Components reviewed

| Component | Status | One-line note |
| --- | --- | --- |
| `EventForm.tsx` | RISKY | Wires correctly to `createEvent`/`updateEvent`, but selected-user sharing and group-sharing are silent no-ops in Tier 0; visit-date save triggers a phantom 'maybe' RSVP via `setPreferredVisitDate`. |
| `EventDetailsModal.tsx` | OK | Renders metadata correctly; `acknowledgeWatchUpdate` flow reaches `/api/watch/:id` PATCH. |
| `EventCard.tsx` | RISKY | Edit/delete/share/clone wire up correctly; kebab state is shared between compact and detailed renders, and `kebabTriggerRef`/`kebabMenuRef` are declared once at the component top, so the positioning ref points at whichever button mounted last. |
| `EventList.tsx` | OK | Pure passthrough to `EventCard`. |
| `CalendarGrid.tsx` | OK | Aggregates events per day; edit flow inline; handles parent/session filtering. |
| `RSVPButton.tsx` | RISKY | Conflict-modal query loads up to 500 events via `getMyFeedEvents`; status set works, but `applyStatus` always passes `preferredVisitDate` so it does not clobber. |
| `RSVPList.tsx` | BROKEN | Always renders empty — `getRsvpList` is a stub `{ going:[], maybe:[], not_going:[] }`. Rendered in `EventDetailsModal` and `EventCard` for every event. |
| `WatchForNextYearButton.tsx` | OK | Reaches `/api/watch` create + read; status semantics match the backend. |
| `PreferredVisitDate.tsx` | RISKY | Calls `setPreferredVisitDate` → forces `status='maybe'` when no prior RSVP exists. |

(STATUS legend: OK = no issues found; RISKY = works but has smells/edge cases; BROKEN = a real user-visible bug)

## Flows reviewed

### Create event

- Trigger: `EventForm.tsx:374` `<form onSubmit={handleSubmit}>` — submit button at `EventForm.tsx:907-915`.
- Handler chain: `EventForm.handleSubmit` (L286-350) → `createEvent` (`services/eventService.ts:45-119`) → `dbClient.events.create` → Tier 0 `POST /api/events` (`backend/src/routes/api/events.ts:76-116`) or Tier 1 `supabase.from('events').insert(...)`.
- Side effects after create:
  - `insertSessions` when `data.recurrence_rule` exists (loop of `dbClient.events.create`).
  - `createRecurringTask` if `watchForNextOccurrence && enrollment_url` → `POST /api/agent-tasks`.
  - `createEnrollmentMonitorTask` if `enrollment_deadline` is set → `POST /api/agent-tasks`.
  - `setEventSharedWithGroups` — **no-op stub** (`groupService.ts:72-74`).
  - `upsertEventSource` for `enrollment_url` → `POST /api/sources`.
  - `setPreferredVisitDate` after success when `hasValidRange && visitDateTime` — phantom RSVP risk (see Issues).
- Status: WORKS but with documented no-op sharing for `selected` users and group-share.
- Notes: `event_status` is derived in the service (`eventService.ts:58-72`). The "I missed this event" + "Watch for next occurrence" combination is not handled — both branches gated by `!isMissed` / `isMissed`, so checking both leaves status to fall through to the `startDate < now` branch and end up as `past`.

### Edit event

- Trigger: `EventForm.tsx:907-915` submit (same form).
- Handler chain: `handleSubmit` → `updateEvent` (`services/eventService.ts:121-165`) → `dbClient.events.update` → Tier 0 `PATCH /api/events/:id` (`backend/src/routes/api/events.ts:131-155`) — backend restricts to `ALLOWED_UPDATE_COLUMNS`.
- Pre-population: `useEffect` at `EventForm.tsx:138-169` reads from the `event` prop, then fires `getEventSharedWithUserIds`/`getEventSharedWithGroupIds`/`getMyRsvp`. **Both `getEventSharedWithUserIds` and `getEventSharedWithGroupIds` return empty arrays** in Tier 0 (`eventService.ts:185-188`, `groupService.ts:67-69`). Users will see "no friends selected / no groups selected" on every edit regardless of the actual saved sharing state.
- Status: WORKS for core columns; sharing state cannot round-trip.
- Notes: `updateEvent` strips `event_status` and `shared_with_user_ids` from the payload, then only re-adds `event_status` when `opts.newStatus` is provided. Selected-user sharing is never persisted.

### Delete event

- Trigger: `EventCard.tsx:618` (compact kebab) and `EventCard.tsx:773` (detailed) `onClick={() => onDelete(event.id)}`.
- Handler chain: `EventCard.onDelete` callback → `MyFeed.handleDeleteClick` (`MyFeed.tsx:99-102`) → opens `ConfirmModal` → `handleDeleteConfirm` (`MyFeed.tsx:104-113`) → `deleteEvent` (`eventService.ts:167-174`) → `dbClient.events.delete` → Tier 0 `DELETE /api/events/:id` (`events.ts:157-168`).
- Status: WORKS. Confirmation modal is wired; ON DELETE CASCADE wipes sessions/rsvps/agent_tasks.
- Notes: `EventCard` is also rendered by `CalendarGrid` and `Timeline`, which forward the same `onDelete` prop. Confirmed `EventCard` always guards delete with `isOrganizer` check (`EventCard.tsx:615, 770`).

### RSVP toggle

- Trigger: `RSVPButton.tsx:96` `onClick={() => handleSet(s)}` for each of going/maybe/not_going.
- Handler chain: `handleSet` → conflict-day check via `getMyFeedEvents` (`viewService.ts:8-16`) → optional `Modal` → `applyStatus` → `setRsvp` (`rsvpService.ts:45-55`) → `dbClient.rsvp.upsert` → Tier 0 `POST /api/rsvp` (`rsvp.ts:35-55`).
- Status: WORKS for the write path. Re-fetch is via `getMyRsvp` (`rsvpService.ts:27-43`) which calls `GET /api/rsvp?event_id=…`. `RSVPList` for others is **broken** — see Issues.
- Notes: `applyStatus` passes the loaded `preferredVisitDate` so it doesn't clobber. The conflict-day check loads up to 500 events on every Going/Maybe click — not free, but acceptable for single-user.

### Watch-for-next-year

- Trigger: `WatchForNextYearButton.tsx:78-87` `onClick={handleClick}`.
- Handler chain: `handleClick` → `createRecurringTask(event.id, enrollment_url, opts)` (`agentTaskService.ts:3-17`) → `dbClient.agentTasks.create` → Tier 0 `POST /api/agent-tasks` (`agentTasks.ts:44-78`); backend route inserts a `recurring_check` row in `plannen.agent_tasks` with ON CONFLICT (event_id, task_type) DO UPDATE. After create, `getEventWatchTask` calls `dbClient.watch.list({ event_id })` → `GET /api/watch?event_id=…` (`watch.ts:33-48`).
- Status: WORKS. The button is gated on `event.enrollment_url`. EventForm's "Watch for next occurrence" checkbox at create time runs the same `createRecurringTask` after `createEvent` resolves (`EventForm.tsx:326-328`).
- Notes:
  - Backend `GET /api/watch` returns BOTH `recurring_check` and `enrollment_monitor` tasks for the event (no task_type filter in the SQL). `getEventWatchTask` returns `rows[0]` ordered by `next_check ASC NULLS LAST`. If an event has an enrollment_monitor due sooner, the UI badge "Watching · Last checked X" will reflect the enrollment_monitor's state, not the recurring_check. **Stale code smell** rather than a functional break.
  - Status mapping: the backend constrains status to `'pending' | 'active' | 'completed' | 'failed'`; the button only branches on `failed` / `pending` / else. `completed` is treated as "Watching" — likely wrong but unreachable under current cron behavior.

### Preferred-visit-date set

- Trigger: `PreferredVisitDate.tsx:97` `<input type="datetime-local" onChange={handleChange} />` (when `showPicker`), or via `EventForm.tsx:691` for the wizard.
- Handler chain: `PreferredVisitDate.handleChange` (L73-83) → `setPreferredVisitDate` (`rsvpService.ts:58-63`) → fetches current RSVP, defaults status to `'maybe'` if absent, calls `setRsvp(eventId, currentStatus, date)`.
- Status: BROKEN (semantic) — see "Issues found".
- Notes: For event creators on solo-mode, every visit-date pick writes `status='maybe'`. That row then appears in `getMyRsvp` and surfaces a `MyRsvpBadge` "Maybe" pill on the card.

## Issues found

### [BROKEN] `setPreferredVisitDate` silently writes `status='maybe'` for events without a prior RSVP

- Location: `src/services/rsvpService.ts:58-63`
- Description: `setPreferredVisitDate` fetches the current RSVP and falls back to `'maybe'` when no row exists, then upserts that status with the date. Every visit-date pick from `PreferredVisitDate`, the `EventForm` wizard step 2, and even the create flow at `EventForm.tsx:337-341` triggers this. The user never asked to be marked Maybe.
- Evidence:
  ```ts
  export async function setPreferredVisitDate(eventId: string, date: string | null): Promise<{ error: Error | null }> {
    const { data, error: fetchErr } = await getMyRsvp(eventId)
    if (fetchErr) return { error: fetchErr }
    const currentStatus = data?.status ?? 'maybe'
    return setRsvp(eventId, currentStatus as RsvpStatus, date)
  }
  ```
- Suggested fix: Either (a) skip the RSVP write entirely when there is no existing RSVP and a separate "preferred_visit_date only" RPC isn't available — store visit date on the event row instead, or (b) default to `going` for the organizer or use a new dedicated nullable column / RPC. At minimum, default to `going` not `maybe` for `created_by === user.id`.

### [BROKEN] `RSVPList` always renders empty buckets

- Location: `src/services/rsvpService.ts:120-127`
- Description: `getRsvpList` is a stub: `return { data: { going: [], maybe: [], not_going: [] }, error: null }`. The component is rendered unconditionally inside `EventDetailsModal.tsx:183` and `EventCard.tsx:911`. Because the buckets are always empty, the "No RSVPs yet." branch (`RSVPList.tsx:17`) fires for every event in every view. In a single-user app this might be intentional, but the empty-state still claims "No RSVPs yet" rather than hiding the section.
- Evidence:
  ```ts
  export async function getRsvpList(_eventId: string): Promise<{...}> {
    // Listing all RSVPs for an event with joined user details is not surfaced
    // by the v0 REST contract — return an empty bucket structure.
    return { data: { going: [], maybe: [], not_going: [] }, error: null }
  }
  ```
- Suggested fix: Hide the section when there is no relationship UI to render (early-return when `total === 0` AND there are no friends/family). Alternatively, expose a `GET /api/rsvp?event_id=…&include_others=true` endpoint that joins user names.

### [BROKEN] Sharing UI promises that the form silently drops

- Location: `src/services/eventService.ts:108-114` and `src/services/groupService.ts:72-74` and `src/services/relationshipService.ts:40-44`.
- Description: The wizard step 3 (`EventForm.tsx:741-802`) exposes `Selected friends` and `Groups` pickers. On submit:
  - `shared_with_user_ids` is computed by `FriendPicker` but `eventService.createEvent` deliberately skips persisting them (comment at `eventService.ts:108-111`).
  - `setEventSharedWithGroups` returns `{ error: null }` immediately without writing anything (`groupService.ts:72-74`).
  - `getMyFriends` / `getMyGroups` return placeholder rows with `email: null, full_name: null` (`relationshipService.ts:40-44`), so the picker shows raw UUIDs as labels.
- Evidence (eventService):
  ```ts
  if (data.shared_with_friends === 'selected' && data.shared_with_user_ids?.length) {
    // event_shared_with_users is not yet surfaced via REST — skip in Tier 0;
  }
  if (data.shared_with_group_ids?.length) {
    await setEventSharedWithGroups(event.id, data.shared_with_group_ids)  // no-op
  }
  ```
- Suggested fix: Either gate the UI behind a Tier 1 backend mode flag, or remove these wizard fields until v1 REST exposes the join tables. The current UX promises functionality that does not exist.

### [BROKEN] "Watch for next occurrence" cannot be unset by unchecking it in the edit form

- Location: `src/components/EventForm.tsx:319-321` (handler), `:817-823` (the checkbox).
- Description: When editing an event with `event_status='watching'`, the checkbox is pre-checked (L167). Unchecking it does nothing on submit unless `convertFromWatching` is also checked. Status remains `'watching'` and the existing `recurring_check` task continues to run.
- Evidence:
  ```ts
  } else if (watchForNextOccurrence) {
    statusOption = { newStatus: 'watching' }
  }
  // no else-branch — unchecking leaves statusOption undefined → status not changed
  ```
- Suggested fix: When `event.event_status === 'watching'` and the user unchecks `watchForNextOccurrence` AND does not set `convertFromWatching`, treat that as "stop watching" — set status to `going`/`past` based on start_date AND delete or mark the watch task `completed`.

### [RISKY] Phantom 'maybe' RSVP created by EventForm visit-date persistence

- Location: `src/components/EventForm.tsx:329-333` and `:337-341`.
- Description: Both create-flow and edit-flow call `setPreferredVisitDate` whenever `visitDateTime` is set. Combined with the broken default in rsvpService, every event with a visit date triggers a Maybe RSVP for the creator, which then renders a "Maybe" `MyRsvpBadge` on their own card.
- Evidence:
  ```ts
  if (createdEvent && hasValidRange && visitDateTime) {
    const preferredVisitIso = new Date(visitDateTime).toISOString()
    const { error: visitErr } = await setPreferredVisitDate(createdEvent.id, preferredVisitIso)
    ...
  }
  ```
- Suggested fix: Tie the fix to the rsvpService change above. Alternatively, default `currentStatus` to `'going'` in `setPreferredVisitDate` when the caller is the event creator (the common case).

### [RISKY] `EventCard` kebab refs are shared across both compact and detailed render paths

- Location: `src/components/EventCard.tsx:162-164` (refs), `:541`/`:783` (button uses same `kebabTriggerRef`/`kebabMenuRef`).
- Description: The component renders either a compact `<article>` (L347-557) OR a detailed `<article>` (L635-922) depending on `viewMode`. Both paths reuse the same single set of refs and a single `showKebabMenu` state. Within one render this is fine, but the detailed path renders TWO calendar-portals with overlapping handlers — the "Add to calendar" button at L780-794 is the actual kebab trigger for the detailed view, but the `MoreVertical` kebab at L538-551 (compact) is structurally identical and never rendered together. The `useLayoutEffect` at L217-231 reads from `kebabTriggerRef.current` without checking which render path is active. This works today because only one path mounts at a time, but it is brittle.
- Suggested fix: Split the kebab into a small subcomponent that owns its own refs and state.

### [RISKY] `getEventWatchTask` returns the first row regardless of task_type

- Location: `src/services/agentTaskService.ts:43-48`, backend `routes/api/watch.ts:33-48`.
- Description: An event with both a `recurring_check` and an `enrollment_monitor` task will surface whichever has the earliest `next_check`. The UI uses `task.status`, `task.update_summary`, `task.has_unread_update` from this row as if it were the recurring watch. The two tasks have different semantics and the UI does not distinguish.
- Evidence:
  ```ts
  export async function getEventWatchTask(eventId: string): Promise<WatchTask | null> {
    const rows = await dbClient.watch.list({ event_id: eventId })
    if (!rows.length) return null
    return rows[0] as unknown as WatchTask
  }
  ```
- Suggested fix: Filter to `task_type === 'recurring_check'` client-side, or accept a `task_type` parameter.

### [RISKY] Conflict-day check loads up to 500 events on every Going/Maybe click

- Location: `src/components/RSVPButton.tsx:56-83`.
- Description: Each click on Going/Maybe re-fetches the entire feed via `getMyFeedEvents` (calls `dbClient.events.list({ limit: 500 })`). On a single-user app with a moderate event count this is fine, but the query is unscoped to the target date.
- Suggested fix: Pass `from_date`/`to_date` window (24h around `eventStartDate`) to `dbClient.events.list`; the Tier 0 backend already supports those query params (`events.ts:55-68`).

### [RISKY] Local-time date handling without timezone or all-day support

- Location: `src/components/EventForm.tsx:14-33` `toDateTimeLocal`, plus every use of `new Date(formData.start_date).toISOString()` at `EventForm.tsx:299`.
- Description: All datetimes are local-time → ISO conversion. There is no all-day toggle; an event with `start=09:00` saved in Brussels and viewed elsewhere will shift. Multi-day events use `startOfDay` from date-fns (`CalendarGrid.tsx:73-94`) which is local-time, so DST transitions can cause off-by-one days in rare cases. Acceptable for a single-user local app per CLAUDE.md, but worth flagging.
- Suggested fix: Store the user's IANA timezone on the user_profile, or add an `all_day` flag on the event row.

### [MINOR] `cancelled` status has no UI affordance

- Location: `src/types/event.ts:2` (status enum), `src/components/EventCard.tsx:22-30` (badge map).
- Description: `EventStatus` includes `'cancelled'`, the badge map renders it, but `EventForm` never lets the user set it. No reachable path puts an event into `cancelled` via the UI.
- Suggested fix: Add a "Cancel event" action in the kebab menu, or remove the status from the enum.

### [MINOR] `EventDetailsModal.handleViewParent` opens a nested modal without closing the outer one

- Location: `src/components/EventDetailsModal.tsx:73-77`, `:205-215`.
- Description: Clicking the parent-event chip opens a second `EventDetailsModal` on top of the first. Both modals remain open; only the inner one has a close button. There is no escape-key handling to dismiss specifically the inner modal.
- Suggested fix: Either close the outer modal before opening the parent, or replace with a "Navigate to parent" action that swaps the modal content.

### [MINOR] `EventForm.handleSubmit` re-uses `formData.start_date` for ISO conversion even when it is already ISO-shaped

- Location: `src/components/EventForm.tsx:299-303`.
- Description: `new Date(formData.start_date).toISOString()` works whether the input was `yyyy-MM-ddTHH:mm` or already an ISO string. But the field is also written via `toDateTimeLocal` after AI scrape, and a user can paste an ISO-Z value into the URL extractor flow — there's no defensive check that the format is valid before parsing.
- Suggested fix: Add a guard `if (Number.isNaN(d.getTime())) throw new Error('Invalid date')` before submitting.

### [MINOR] Stale comment in `eventService.upsertEventSource`

- Location: `src/services/eventService.ts:8-20`.
- Description: Comment claims event_source_refs is not surfaced via REST and that Tier 1 used to write both — this is accurate for v0 but should link to a follow-up issue or be removed once `/api/sources` upsert is finalized.
- Suggested fix: Either drop the join-row write expectation or open an issue and reference it here.

## Open questions

- **Is `RSVPList` deliberately a stub** because this is single-user, or is the Tier 1 path (which previously joined `event_rsvps` with `users`) supposed to be restored? The comment at `rsvpService.ts:124` suggests v0 REST is the constraint, but Tier 1 supabase client could still issue the join — the dbClient contract just doesn't expose it.
- **Is the `selected friends` / group-share UI a known cut for v0**, or is `setEventSharedWithGroups` expected to land in v1? If known-cut, the UI should be gated on `VITE_PLANNEN_BACKEND_MODE !== 'plannen-api'`.
- **Does `event_status='completed'` ever exist on a watch task row?** The schema check allows it but I could not find a writer. If unreachable, the `WatchForNextYearButton` status branching should be tightened.
- **Should `setPreferredVisitDate` write to the event row instead of the RSVP row** for the organizer's own visit? Could not determine the product intent from static analysis — the comment at `EventForm.tsx:683` "Visit date & time (optional) … You can set this now while creating the event" implies it is a planning-only field, which argues for moving it off the RSVP table entirely.
- **Are there any callers that pass `recurrence_rule` to `EventForm`?** `EventFormData.recurrence_rule` is on the type but no UI control sets it. `eventService.createEvent` honors it (`eventService.ts:99-101`) and `insertSessions` generates sessions. Search across `src/` shows no setter — possibly invoked from the agent chat path that I did not trace here.
- **`my_rsvp_status` enrichment** — `Event.my_rsvp_status` is on the type but `viewService.enrichWithRecurrenceContext` does not populate it. `EventCard.tsx:140` reads `event.my_rsvp_status ?? null` and falls back to `getMyRsvp`. Confirm whether some upstream is supposed to populate this to save a round-trip per card; in the meantime each card fires its own `GET /api/rsvp?event_id=…`.
