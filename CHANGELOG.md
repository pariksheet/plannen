# Changelog

All notable changes to Plannen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.1] - 2026-06-16

### Starred group gets the full view switcher

- **Your starred group now opens on a Schedule dashboard, just like My Plans.** Opening the starred (primary) group — e.g. "My Family" — gives you the same three-way switcher (Schedule / Compact / Calendar) the personal feed has, and lands on Schedule by default. Every section (Today, Overdue, the week agenda, and the month calendar) is scoped to the events shared with that group. Other groups and the "All" view are unchanged, keeping Compact and Calendar.

## [0.7.0] - 2026-06-16

### Web UI parity — do it in the app, not just via the assistant

- **Things that used to need the assistant now have a home in the web app.** This release closes the biggest gaps between what the assistant could do and what the UI exposed: your saved sources, profile facts (add and correct them inline), and mail mute rules are now browsable and editable; attendances, obligations, and blackout windows have management screens; and one-off activity logging is available directly from the app.
- **Stubbed service paths are live again.** Several UI actions that silently did nothing now actually call through to the backend, so what the screen shows matches what's stored.

### Event creation — a faster, clearer form

- **A leaner, less cluttered create/edit flow.** The form now adapts to what you're making: to-dos and reminders are a single screen instead of a multi-step wizard, the title field is focused the moment the form opens, and the confusing "Type" field is gone. The cover-image and event-link rows were compacted (with a matching neutral "Scan flyer" button), reminders no longer ask for an end time, and a recurrence summary spells out exactly which dates a repeat will create.
- **"Trip" is a first-class thing you can create.** Alongside Event, Reminder, and To-do, you can now make a Trip directly from the form and file other items under it with a simple "Add to a trip" checkbox.
- **Visit date only appears when it makes sense.** The "which day are you going?" field is now hidden behind a one-day checkbox and only shows for events that actually span multiple days; it's clamped and reconciled on save so a stale value can't linger after you change the dates.

### Trips across the calendar and schedule

- **Trips show as spanning bands on the calendar** and as distinct violet "trip" rows in the schedule lists, so a multi-day plan reads as one block instead of scattered dots.
- **Events and to-dos filed under a trip inherit the trip's sharing by default**, with a one-click "sync" button to push the trip's current sharing onto everything in it. The inherited setting is just a starting point — a compact "Share with" control on events, to-dos, and reminders lets you override it per item, and your explicit choice always wins.

### Schedule view polish

- **Only completed to-dos get struck through** — past events and reminders stay legible — and each row carries a small icon for its kind. The month calendar's day view gained the same kind icons and a working to-do checkbox you can tick straight from the schedule.

## [0.6.5] - 2026-06-15

### Daily brief — surface overdue to-dos

- **The morning brief now opens with what's overdue.** The daily plan gained an "Overdue" section, shown above the day's schedule, listing any open to-do whose due date slipped past within the last 30 days — oldest first, each tagged with its original due date. Completed and cancelled items are filtered out, so the list reflects only what still needs doing, and the section disappears entirely on days with nothing outstanding.

## [0.6.4] - 2026-06-15

### Trips — group related plans under one container (data model)

- **A new "container" event type bundles related plans.** A trip (or any multi-day umbrella) is now its own kind of event that spans a date range and acts as a hub: child events, named to-do lists, and memories can hang off it via a shared group. This release lays the foundation at the data and assistant-tool layer — the dedicated trip hub in the web app comes next.
- **Group events together and label to-do lists.** Events can now reference the container they belong to, and a to-do can carry a list label so checklists under a trip stay organised. The grouping survives deleting the container — children simply detach rather than disappearing.
- **Integrity guaranteed at the database.** A container can't be nested inside another container, and list labels are restricted to to-dos. These rules are enforced by the database itself on every write path, so the invariants hold no matter how an event is created or edited.

### Fixes

- **Creating an event no longer fails after the family-sharing change.** A leftover reference to a removed `shared_with_family` column would cause every event-creation call to error; event creation now uses the current set of columns and works again.

## [0.6.3] - 2026-06-13

### Event attribution — someone else's event stops blocking your calendar

- **Mark an event as someone else's.** An event can now be attributed to a family member or a connected friend, so it still appears on your calendar but no longer counts as *you* being busy. A child's class or a friend's party you're just tracking stops raising false "⚠ overlaps" warnings against your own plans.
- **Say when you're actually there.** Attribution and "is this my time" are independent: if you also attend — you stay rather than drop off — the event keeps normal clash detection, so a genuine double-booking still flags. When it's unclear, the safe default is "not my time" so you aren't nagged with overlaps.
- **A name chip shows whose event it is.** Attributed events display a small muted chip with the person's name in the schedule. The subject and whether you attend are set conversationally — the assistant infers them from how you describe the event — and both server runtimes accept the new fields (a forward-only migration adds them).

## [0.6.2] - 2026-06-12

### Mailbox sync

- **"Open attachment" todos no longer land at 12:00 AM.** When an email's date is locked inside an attachment the sync can't read, the fallback todo used to be dated on the bare message date — which stored as local midnight and surfaced as a meaningless 12:00 AM slot. It now starts at the email's received time plus one hour, so it shows up in the day's actionable flow.

## [0.6.1] - 2026-06-11

### Schedule card fixes

- **The "⋮" card menu no longer gets clipped on scroll.** It now follows its button as the page scrolls, flips open upward when there isn't room below, and scrolls inside itself when it's taller than the screen — every option stays reachable.
- **Turn any event into a to-do.** "Convert to to-do" is now offered on regular events from the card menu, not just on reminders and existing to-dos.
- **Today's schedule reads as one block.** Today's items render as a single continuous highlighted strip instead of separate boxes with gaps between them.
- **Click away to collapse an open event.** Clicking empty space — or anywhere outside an expanded card — now closes the inline event you opened in the schedule, so you no longer have to click the same row again. Opening the card's details popup or its menu no longer collapses the card by accident.

### Logging

- **A one-off activity no longer seeds a recurring routine.** Recording a single timed activity (e.g. a one-time "slept 8h") could be mistaken for a repeating habit and create a recurring routine; single entries now stay single unless you actually keep a matching routine.

## [0.6.0] - 2026-06-10

### Activity logging — capture anything you did or measured

- **`/log` now records activities with a duration or a quantity.** Things like "slept 8h last night", "ran 40 min", "drank 2L water", "weight 72kg", or "mood 4/5" now land in a new generic activity log — the gap the first `/log` release left as "coming soon". The activity is a free-form label (sleep, run, water, weight, mood, whatever you say), so nothing is hard-coded to specific categories; each entry carries a duration, a quantity + unit, or just a note.
- **Logging an activity also ticks a matching routine.** If you say "ran 40 min" and you keep a "run" routine, the run is logged *and* the routine is marked done for the day in one step — your streak follows the data without a second command.
- **Ask how you're doing over time.** "How much did I sleep this week?" / "How often did I run this month?" read back from the log so you can see totals and frequencies.
- **Works on mobile, no app UI needed yet.** The logic lives in three new tools (log / list / delete) on both server runtimes, so the behaviour is identical in the Claude mobile app. A visual view for trends is a deliberate later pass.

## [0.5.0] - 2026-06-10

### /log — a frictionless journal that works on mobile

- **One verb to capture anything that happened.** A new `/log` command (and bare past-tense reports like "just finished gym today" or "met our new neighbour, lives on our street") records a finished chore, a completed routine, a future todo, or a fact about a person/place — and files it in the right place immediately, then shows a one-line receipt you can `undo`. Logging deliberately bypasses the usual "want me to save this?" gate; it's capture, not planning.
- **Smart, dedupe-safe completion.** When you report finishing something, it resolves conservatively: completes an existing open todo if one matches (no duplicate), else marks a matching routine done, else logs a fresh completed todo. It never auto-creates a routine, and never guesses when the match is ambiguous.
- **Works the same on the mobile app.** The new `log_completion` MCP tool (added in both server runtimes) does the resolution server-side, and the routing rules + guard rails now ship as MCP server instructions — so the journal behaves identically in the Claude mobile app, which loads no plugin. Guard rails keep it from acting on questions, intentions, or hypotheticals.
- **Activity time-blocks (sleep, durations) are next.** Logging "slept 8h last night" returns a friendly "coming soon" for now; the duration/activity store lands in a follow-up. No migration in this release — `/log` reuses existing tables.

## [0.4.3] - 2026-06-10

### Schedule page: Today-first week + denser calendar

- **"This week" now opens on Today, with tap-to-widen ranges.** The card defaults to just today's items (events + folded routines), and a `Today · This Week · Next Week` selector lets you widen the view: This Week shows the full Mon–Sun agenda; Next Week peeks at the following week's events. Routines still fold into Today only, so they appear under Today/This Week but not Next Week.
- **The month calendar shows more at a glance.** Compact day cells now render up to 11 dots per kind (events / reminders / todos) before the "+" overflow, instead of 5 — so a busy day reads more accurately without expanding.

## [0.4.2] - 2026-06-10

### Routines folded into the day

- **No more separate "Routines" list — routines now live inside your day.** The dedicated Routines section (Schedule view) and Practices section (Today view) are gone. Instead, a routine appears inline in "This week"/"Today" only when it's relevant **today**: a date-cadence routine on the days it fires, and a "N×/week or /month" routine until you've hit the target for the period. They render as ordinary checkable items, interleaved with your events by part-of-day (a morning routine among the morning items, "anytime" ones at the end).
- **Ticking one keeps it in view.** A completed routine stays, checked off, for the rest of the day (untick to undo); a flex routine shows its progress (e.g. `1/3 this week`) and drops off once the target is met. Routines that don't apply today simply don't show — no noise.

## [0.4.1] - 2026-06-10

### Attendances & drop/pick now visible in the web app

- **The daily schedule view now shows attendances and derived drop/pick.** The web app renders today's expanded, blackout-suppressed attendances (as muted indicative context) and the override-resolved drop/pick obligations (as timed items tagged with their source), computed client-side from your own RLS-scoped data — so they auto-suppress on blackout days and follow the child to a camp, exactly as the briefing does. Completes the Phase 2/3 UI; creation remains agent-driven through the intent gate.

## [0.4.0] - 2026-06-10

### Attendances, blackout calendars & derived drop/pick (unified scheduling Phase 2 + 3)

- **Family-member enrolments are now first-class.** You can record that a member attends a place on a recurring schedule — school, creche, camp — with a location, start/end times, a recurrence (every-N-days / weekdays / monthly, same shape as events and routines), and a priority. Attendances are *indicative context*: they show where a member is, but never create work for anyone by themselves and never trip the conflict checker.
- **Blackout calendars suppress attendances automatically.** A named set of date ranges (e.g. a school's holidays) can be linked to an attendance; on any covered date the attendance — and anything derived from it — silently disappears for that day. No hand-maintained exceptions.
- **Drop/pick tasks that follow the child.** A derived obligation links a drop or pick to an attendance (anchored to its start or end, with a signed offset — e.g. drop 15 min before start, pick at end). It stays linked and re-projects at read time: it auto-suppresses during blackouts, and when a higher-priority bounded enrolment (a camp week) overlaps an open-ended one (the school term), the drop/pick automatically swap to the camp's times and location — even if you forgot to mark the school holiday.
- **The morning briefing reflects all of it.** `get_briefing_context` now returns the day's expanded, blackout-suppressed attendances (as indicative context) and the override-resolved, projected drop/pick obligations (as actionable timed items) — so the day plan stays correct as schedules change, with no regeneration.
- **Opt-in, never automatic.** When Plannen learns of an attendance with no drop/pick, the agent offers to add them once ("…want me to add a drop and a pick, or do they go on their own?") and only creates them on a yes — mirroring the existing event-creation intent gate.
- New MCP tools (both runtimes, in parity) for managing attendances, blackout calendars/windows, and obligations. Web rendering for the new items is scaffolded (agent-managed for now). No personal data — all examples use generic personas.

## [0.3.0] - 2026-06-10

### Unified recurrence on routines (Phase 1)

- **Routines now express any cadence, not just three fixed shapes.** The old practice model (`daily` / `weekly_count` / `specific_days`) is replaced by a unified recurrence with two flavors. **Pinned** routines fire on a real date cadence — every other day (e.g. meal prep), specific weekdays, or monthly — via a structured recurrence rule (`{ frequency, interval, days }`, the same shape events already use). **Flex-count** routines are "N times per period, anytime" — gym 3×/week, deep-clean twice a month — tracked as progress rather than a fixed slot.
- **"Every other day" and other intervals finally work.** Cadences like meal-prep-every-2-days, biweekly walks, or monthly tasks are now first-class; previously they could only be approximated.
- **Progress counts respect the right period.** Weekly routines count from Monday; monthly routines count across the whole calendar month. The Routines cards on Today and the Schedule overview render natural labels — "Gym (2/3 this week)", "Meal prep (every 2 days)", "Walk (Mon/Wed/Fri)" — with period-aware completion progress.
- **Clearer guidance on what is and isn't a routine.** Time-pinned commitments tied to a place (a school drop-off at 08:15) belong to a recurring event, not a routine — routines stay time-flexible and carry only a coarse part-of-day preference. The agent guidance and the create/update routine tools document the new model with concrete examples.

## [0.2.3] - 2026-06-10

### Tooling

- **New `/release` maintainer command.** A single repo command (`.claude/commands/release.md`) now cuts a release end-to-end: it bumps the package and plugin versions in lockstep, drafts this changelog, opens and squash-merges the release PR, tags the commit, and publishes the GitHub Release. The plugin manifest version is always pinned equal to the package version, and the previously-missed "publish a GitHub Release" step is now built in, so tags and Releases can't drift apart again. Not shipped in the plugin — it's a maintainer tool only.

## [0.2.2] - 2026-06-10

### Schedule view: tighter mobile header

- **Create Event collapses to a + icon on mobile.** The button now shows only the plus glyph on small screens (matching the Discover button) and the full "Create Event" label returns at the `sm` breakpoint and up.
- **Tabs and actions share one row.** `Schedule | Calendar | Timeline` and the Discover / Create buttons now sit on a single row instead of the actions wrapping to a full-width line below the tabs.

### Versioning

- **Plugin version realigned to the package version (`0.2.2`).** The plugin manifest had drifted to `0.1.x` while git tags tracked the package's `0.2.x`; both now move together so tags stay consistent.

## [0.2.1] - 2026-06-10

### Schedule view: Overdue to-dos, modal & overlap fixes

- **New "Overdue" section in the Schedule view.** Past, unchecked to-dos surface in their own section above *This week*; the section is hidden entirely when nothing is overdue, and overdue to-dos are lifted out of the week list so they're never shown twice.
- **To-dos no longer clutter the *This month* sidebar.** They keep their amber dot on the calendar grid (and on day-click) but drop out of the month list, which now reads as an events/outings list — matching how reminders are already treated there.
- **Event detail modal no longer renders washed-out.** `Modal` now mounts through a `document.body` portal, so a dimmed ancestor (e.g. a past-event row at 60% opacity) can't cascade its transparency onto the dialog.
- **Reminders never trigger the "⚠ overlaps" tag.** Overlap detection ignores reminders — they're nudges, not attendance commitments, so a reminder neither clashes nor flags another event.

### Mailbox & Smartschool sync: event / to-do / reminder classification

- **The mailbox sync now classifies mail into the right kind.** An explicit decision tree: something you attend → `event`; a discrete action to complete by a date (pay, book, RSVP, renew, submit) → `todo`; a pure heads-up → `reminder`.
- **Attachment-locked invites become actionable to-dos.** When an event-worthy message's date lives in a PDF the routine can't read, both the mailbox and Smartschool syncs now create a `todo` that tells you to open the original — instead of guessing a calendar event on the wrong day.

## [0.2.0] - 2026-06-10

### To-do event type

- **A new `todo` event kind: a dated, checkable, one-off task.** Fills the gap between passive reminders (which never get "done") and recurring practices (which can't be one-off). A todo has a full datetime like an event, a completion checkbox, and is assigned to its creator by default.
- **Shown across all three plan views.** Todos render with a leading checkbox in the Schedule week list, the Timeline (via the reused `EventCard`), and the Calendar (a new amber dot alongside blue events / green reminders). The MyFeed timeline gains a matching amber "To-dos" filter pill.
- **Completion + overdue states.** Ticking a todo strikes through and dims it in place; an unchecked todo whose datetime has passed is flagged "overdue" and stays put (completion is tracked via `completed_at`, never the `event_status` auto-resolver, so an unfinished task never silently ages into the past).
- **Convert between reminder and to-do** from the card's kebab menu, in both compact and detailed views.
- **MCP.** `create_event` accepts `event_kind: 'todo'` (+ optional `assigned_to`, defaulting to the creator); new `complete_todo` / `uncomplete_todo` tools, mirrored in both the local stdio and edge servers.
- **Schema.** Additive, forward-only migration adds `completed_at` and `assigned_to` columns to `events` and extends the `event_kind` check constraint.

## [0.8.4] - 2026-06-05

### claude.ai custom connector (OAuth)

- **The MCP edge function can now be registered as a claude.ai custom connector.** One registration propagates to claude.ai web, Claude Desktop, mobile, and Claude in Chrome. `authenticate()` accepts Supabase Auth JWTs alongside the existing `plnnn_` PATs (which are unchanged — the Claude Code plugin keeps working as-is); both resolve to the same per-user RLS context. JWT verification pins asymmetric algorithms (ES256/RS256) against the project JWKS.
- **OAuth discovery surface.** The function serves RFC 9728 protected-resource metadata at `…/mcp/.well-known/oauth-protected-resource` and advertises it via `WWW-Authenticate` on 401s; Supabase Auth (OAuth 2.1 server with dynamic client registration) acts as the authorization server.
- **Consent page.** New `/oauth/consent` route in the web app — shows the requesting client + scopes, Approve/Deny, with a login bounce that preserves the authorization request.
- **CLI.** New `plannen cloud oauth enable|status --profile <name>` (idempotent Management-API wiring + prints the connector URL), and `cloud provision` gains a final `enable-oauth` step so fresh Tier 2 installs come up claude.ai-connectable.

### Timezone-naive dates interpreted in the user's timezone

- **`create_event`/`update_event` no longer shift naive timestamps.** A timezone-naive `start_date`/`end_date` (e.g. `2026-06-06T09:30:00`) was resolved against the server timezone (UTC on the edge), so a 09:30 event round-tripped to 11:30. New `parseInUserTz()` interprets naive values in the profile timezone in both MCP implementations; explicit offsets/`Z` are respected.

## [0.8.3] - 2026-06-04

### Cancelled events excluded everywhere

- **Daily briefing (MCP).** `get_briefing_context`'s events-today / events-tomorrow / recent-past queries now filter `event_status <> 'cancelled'` in both MCP implementations (local stdio server + Supabase edge function). Previously a cancelled event still appeared in `/plannen-today` briefings.
- **Schedule view + calendar.** The Today / This week / This month cards and `CalendarGrid` (calendar view-mode, MyGroups, MyPeople) no longer render cancelled events. The timeline view already excluded them.

### Schedule view UX

- **Clicking an event opens the details card** (same `EventDetailsModal` as the timeline view) instead of jumping straight into the edit form.
- **Icon-only Edit (pencil) in the card header** — `Modal` gains a `headerActions` slot; the details card renders its Edit action there, left of the close button. Wired in ScheduleOverview, CalendarGrid, and EventCard (organizer only).
- **This-month list fills the left column chronologically first**, then the right (CSS columns instead of a row-major grid).

### Deploy: Supabase allow-list pruning

- **`plannen deploy` no longer grows `uri_allow_list` unbounded.** Each deploy appended its ephemeral `plannen-<hash>-<scope>.vercel.app/**` URL until the Management API rejected the PATCH (`URI_ALLOW_LIST` "large values"), breaking the post-deploy auth wire. `updateAuthConfig` now prunes stale per-deployment entries (via a `pruneAllowList` RegExp) before the union — hand-added entries are untouched — and change detection compares content instead of list length. The first deploy after upgrading self-heals an already-bloated server value.

## [0.8.2] - 2026-06-03

### Mailbox sync wrapper hardening

- **Wall-clock timeout on each run.** `scripts/mailbox/sync-wrapper.sh` now caps the `claude -p` sync at 600s (override via `PLANNEN_MAILBOX_TIMEOUT_SECS`). Past the cap the run is TERM→KILL'd and reported as `exit 124` with a logged `[error]` line and a desktop notification. Prefers GNU `timeout`/`gtimeout` when present; otherwise uses a portable, self-cleaning bash watchdog (no orphaned grace-period processes). Fixes the failure mode where a hung run (e.g. 2026-06-02 blocked ~8h on "Request timed out") ran unbounded.
- **Staleness-aware lock.** The `mkdir` concurrency lock now records the holder PID. On contention it checks whether that PID is alive: alive → genuine concurrent run, exit silently (unchanged); dead/missing → orphaned lock from a hard-killed run, logged as `reclaiming stale lock` and reclaimed. Previously a killed run's surviving lock silently blocked **every** subsequent run until the 7-day log sweep — up to a week of no syncing with no error surfaced.

## [0.8.1] - 2026-05-31

### Schedule overview view-mode

- **New "Schedule" view-mode in My Plans**, now the default landing view (a previously-saved calendar/timeline preference no longer overrides it; the toggle still works within a session). Circle-aware overview with a header, Today, This week, This month (mini calendar + grouped upcoming list), and interactive Routines cards.
- **Inline weather** (Open-Meteo, session-cached) shown as compact temp + summary next to the "Your Schedule" heading, replacing the standalone weather card. The "for the &lt;group&gt; family" caption is gone.
- **Today card status.** Events past their end time get a checked box + strikethrough (2h assumed duration when an event has no `end_date`); an event happening now is marked with a "→". A 1-minute tick keeps these live.
- **Filters hidden in Schedule mode** — the kind pills, date filter, and clear-filters control only show in the Timeline/Calendar views.
- **Month-calendar drill-down.** Clicking a day in the month card lists that date's events in the sidebar with a close button back to the upcoming list (new `onDateSelect` on `CalendarGrid`).

## [0.8.0] - 2026-05-27

### Per-user MCP PATs (breaking)

- **MCP authentication moves to per-user PAT, replacing the shared `MCP_BEARER_TOKEN`.** Existing tier-1/tier-2 deployments must run `npx plannen migrate` then `npx plannen token create --label "$(hostname)"` to mint the admin's first PAT. Other Plannen users generate their own PATs at `/settings` after magic-link sign-in. (#37)
- `scripts/mcp-rotate-bearer.sh` removed. Use `plannen token rotate` instead.
- `plannen.user_tokens` table + RLS policies (forward-only migration `20260527140000_user_tokens.sql`).
- `plannen token {create, list, revoke, activate, rotate}` CLI verbs.
- `mcp-token` edge function backing `/settings`.
- Multi-user isolation regression test in `mcp/index.test.ts`.
- `SettingsTokens` React component in `/settings` — Tailwind card with KeyRound header, just-minted callout (Copy → Copied), real empty state, card-list of issued tokens with revoke.
- `plannen init` auto-mints the admin's first PAT during Tier 2 setup (new `mint-pat` step between `deploy` and `rewrite-config`) so the verify step passes against a fresh per-PAT MCP function instead of 401-ing on the stale shared bearer.
- Removed: shared `MCP_BEARER_TOKEN` env read in `supabase/functions/mcp/index.ts`; module-level `_userId` cache in `supabase/functions/mcp/server.ts`; `PLANNEN_USER_EMAIL` read in tier-1/tier-2 MCP function (tier 0 unchanged).

## [0.7.0] - 2026-05-27

### Mailbox sync rework

- **Cadence: every 4h around the clock** (00, 04, 08, 12, 16, 20 Europe/Brussels) instead of hourly 06–23. `RunAtLoad=true` so a cold boot after missed scheduled windows fires the agent immediately. **Re-run `npx plannen mailbox install` after upgrading** to load the new schedule; the wrapper warns on stderr if it detects the old plist.
- **Classifier prompt tightened.** Explicit "Skip outright" categories for mass marketing with date+venue (public ticketed festivals, brand "experience" days, commercial product launches), cold recruiter outreach, transactional renewals (ACME/insurance/subscriptions), and generic public invites where the user is BCC'd. New "addressed-to-me" check — bulk marketing no longer routes to `#review`.
- **In-app mute UX.** Sync-created events now show a `<Mail>` icon on the card and a Source section in the event modal — sender, "View original email", and a Mute… button. The mute dialog offers three rule kinds (sender, whole domain, domain + subject keyword), defaults to muting + deleting the current event, then surfaces a sweep dialog listing other `#mbsync` events the new rule would match so the user can clean up retroactively.
- **Richer ignore rules.** `mailbox_ignore_rules.sender` renamed to `pattern`; new `kind` + `subject_keyword` columns. Forward-only migration; existing rules survive as `kind='sender'`. New SQL helpers `plannen.ignore_rule_matches` and `plannen.find_matching_mbsync_events`.
- **Event provenance sidecar table** (`plannen.event_provenance`) stores source/adapter/sender/subject for each sync-created event. The sync agent's Step E records this after each `create_event`; the web modal reads it on demand. Older `#mbsync` events without provenance still render the modal section with "Source unknown".
- **MCP additions.** `find_matching_mbsync_events`, `add_event_provenance`, `get_event_provenance`. `add_ignore_rule` signature changed: now takes `kind` + `pattern` (replaces single-sender). Both Tier 0 (stdio) and Tier 1/2 (edge function) MCP implementations updated.
- **REST surface.** New Tier 0 routes `/api/mailbox-ignore-rules` (GET/POST/DELETE + `/find-matching`) and `/api/event-provenance` (GET/POST). Web `dbClient` gains `ignoreRules` namespace and `events.getProvenance`.

## [0.6.5] - 2026-05-22

### Added

- **Mailbox event sync routine.** New `/plannen-mailbox-sync` slash command + skill that pulls unread Gmail, classifies for event-worthiness, writes to Plannen, and syncs going-status events to Google Calendar. Progress is tracked by a per-adapter `last_synced_at` checkpoint in `plannen.mailbox_sync_state` (replaces the earlier Gmail-label "mark processed" scheme — no Gmail write scope needed). Dedupe step scans recent events for a `Gmail-ID:` prefix in the description, making the routine self-healing across crashes and boundary-second collisions. (#64)
- **macOS launchd hourly trigger.** `npx plannen mailbox install` writes a LaunchAgent plist at `~/Library/LaunchAgents/work.plannen.mailbox-sync.plist`. Wrapper script (`scripts/mailbox/sync-wrapper.sh`) `cd`'s into the repo, uses a `mkdir`-based lock (macOS doesn't ship `flock(1)`), runs the slash command via `claude -p` with `bypassPermissions`, and surfaces failure JSON via `osascript`. `npx plannen mailbox uninstall` removes it. (#64)
- **Mute-on-dismissal.** Dismissing a routine-created event in the web UI (MyFeed) prompts to mute the sender. Adds a row to `plannen.mailbox_ignore_rules` (per-user, per-adapter, single-sender granularity); future emails from that sender are skipped before classification. `/plannen-mailbox-rules` lists / deletes; `/plannen-mailbox-status` shows recent run logs. (#64)
- **Six new MCP tools.** `list_ignore_rules`, `add_ignore_rule`, `delete_ignore_rule`, `bump_ignore_rule_hit`, `get_mailbox_sync_state`, `set_mailbox_sync_state` — mirrored in both `mcp/src/index.ts` (local stdio) and `supabase/functions/mcp/tools/mailbox.ts` (deployed edge function). (#64)
- **Apply via `npx plannen migrate`** before deploying: `supabase/migrations/20260522180000_mailbox_ignore_rules.sql` and `supabase/migrations/20260522190000_mailbox_sync_state.sql`.

### Fixed

- **Edge-function MCP drift.** `list_event_notes` and batch `event_ids[]` support for `list_event_memories` existed only in `mcp/src/index.ts`; the deployed Supabase Edge Function MCP (which Claude Code talks to in Tier 1/2) was missing them. Mirrored both. Symptom of the drift: tool appears in code/grep but `ToolSearch` can't find it because the edge function never got the schema. (#64)

### Internal

- **CLAUDE.md guardrail** documenting the two-MCP-implementation duality (`mcp/src/index.ts` local vs `supabase/functions/mcp/` edge) so future tool additions land in both places at once. (#64)

## [0.6.4] - 2026-05-22

### Added

- **Audio recording + per-event notes feed the AI story flow.** Two narrow capture surfaces, both routed into stories. (#59)
  - **AudioRecorder.** Tap-to-record / tap-to-stop in the browser via `MediaRecorder` (`audio/webm;codecs=opus`, with `audio/mp4` fallback for Safari). The clip uploads through the existing memory pipeline (`media_type='audio'`) and plays back via the existing `AudioTile`. Cloud transcription is deferred — captions on audio memories plus notes cover the gap for now.
  - **Event notes.** New `plannen.event_notes` table — multi-user, multi-instance, author-scoped writes. RLS mirrors `event_memories` (SELECT delegates to event visibility; INSERT/UPDATE/DELETE author-only). Tier 0 gets matching `/api/event-notes` Hono routes scoped by `events.created_by`.
  - **AI consumption.** New `list_event_notes(event_ids[])` MCP tool returns notes joined with `author_full_name` / `author_email`. The `plannen-stories` skill calls it alongside `list_event_memories` and folds notes into the composition prompt as attributed quotes.
  - **Apply via `npx plannen migrate`** before deploying: `supabase/migrations/20260522123220_event_notes.sql`.
- **Pin a primary group in the navigation.** A user with one frequently-used group (typically a household) gets a dedicated tab immediately before "My Groups" that pre-filters the page to that group. New `plannen.users.primary_group_id` column; `createGroup()` auto-promotes the first group; explicit toggle from ManageGroups via a star icon (amber filled = primary). Deleting the pinned group quietly clears the column (ON DELETE SET NULL). (#59)

### Changed

- **My Groups mobile UX compaction.** Replaces the bordered search input, the "Showing only X" filter banner, and the full-width Manage button with a single horizontal pill row (`[All]` → primary (★) → alphabetical) plus a `Settings` icon button. Recovers ~200px of vertical chrome above the events list on mobile. Tapping a pill navigates to `?view=groups&group_id=<id>`; tapping the active pill clears the filter; URL contract identical to the nav star so star + pill stay bidirectionally in sync. Pill row hides entirely when the user has no accessible groups. (#63)
- **My Plans empty-state + filter redesign.** The feed pulls a -30d..+60d window; users whose only events sat further out (summer camps booked months ahead) used to hit the "create your first event" CTA despite owning events. After an empty windowed result, retry once unbounded and stick on that path for the session so subsequent reloads don't snap back. Filters drop the six rarely-toggled status pills, keep Events + Reminders (both selected by default), and add a Calendar icon that opens the native OS date picker via a label-wrapped invisible input; picking a date outside the current fetch window auto-flips to unbounded and sets `showPast=true` so the date isn't hidden behind the "Earlier" pagination. Date matching honours multi-day events (start..end inclusive). (#59)

### Fixed

- **Members couldn't see groups they were added to.** `dbClient.groups.list` filtered by `created_by = uid`, so a user added as a member never saw the group — even though RLS already allowed it via the "Members can view their groups" policy. Drop the client-side filter; RLS handles visibility. Also adds a fallback in `usePrimaryGroup`: when no `primary_group_id` is pinned and the user has exactly one accessible group, treat it as primary so the nav star stays visible for members who were added to a single group but never explicitly pinned it (auto-pin in `createGroup` only fires for the creator). (#62)
- **`plannen profile use` falsely tripped when background services held the PG port.** The port probe collided with Colima's SSH multiplex forwarding 54321–54326 from the Lima VM, so users with Plannen genuinely not running still hit "previous profile still has services on port 54322. Run `plannen down` first." Switched to the Plannen PG PID file (`~/.plannen/pg.pid`) + `process.kill(pid, 0)` liveness probe as the true "is the previous profile up" signal. The injectable ctx renames from `isPortOpen` to `isProfileRunning`; existing test cases updated, plus new direct tests for `isPgRunning` covering missing/empty/dead/live PID cases. (#60)

### Internal

- **Migration parity import.** Brought the `event_memories.storage_key` migration (originally added on `feat/storage_adapter_r2` and pushed to the sb_prod Supabase project from that session) into `main` so `supabase db push --linked` no longer refuses with "Remote migration versions not found in local migrations directory." Additive and idempotent — `ADD COLUMN IF NOT EXISTS` / `UPDATE WHERE storage_key IS NULL` / `CREATE INDEX IF NOT EXISTS` — re-stating it against the already-migrated remote is a no-op. The accompanying storage adapter TS code lands when `feat/storage_adapter_r2` ships its own PR. (#61)

## [0.6.3] - 2026-05-21

### Changed

- **UI performance pass — four narrow fixes that cut redundant work on the hot views.**
  - **Stories sibling lookup.** `useStory()` was calling `dbClient.stories.list()` (full list) then client-filtering for translation siblings of the open story. Threaded an optional `story_group_id` through `mcp list_stories` → Tier-0 `GET /api/stories?story_group_id=…` → `dbClient.stories.list({ story_group_id })`, so the sibling fetch only returns the group. No behaviour change. (#54)
  - **Memories batching.** `StoryPhotoStrip` and `CoverPicker` were calling `dbClient.memories.list` once per linked event (Promise.all over event_ids). Added `event_ids: string[]` (and an optional `limit`) to `mcp list_event_memories`, Tier-0 `GET /api/memories?event_ids=a,b,c`, and `dbClient.memories.list({ event_ids, limit })`. The two components drop their tier-branching and use one call; they no longer import `supabase` directly. Tier 1 already used `.in('event_id', eventIds)`, so the runtime savings are mostly on Tier 0 — but the code is now one path on both tiers. The MCP tool keeps `event_id` for back-compat with the `plannen-stories` skill. (#55)
  - **Profile lazy-load.** `/profile` was blocking on `Promise.all(getProfile, getLocations, getFamilyMembers)` behind a global "Loading profile…" gate. Moved data ownership into each section so the page chrome paints immediately and each card loads in parallel with a shimmer. `ProfilePersonalInfo` reads `full_name` from `useAuth()` (already in memory) and self-fetches dob/timezone. `ProfileLocations` / `ProfileFamilyMembers` / `ProfileInterestsGoals` each fetch on mount and mutate local state on add/update/delete (the existing `handleDeleteLocation` / `handleDeleteFamilyMember` pattern, extended). `Profile.tsx` shrinks to ~30 lines. (#56)
  - **Feed date window.** `MyFeed` was pulling up to 500 rows on every mount + every mutate. Switched to a 90-day window — 30 days back, 60 days forward — and cascaded the existing "Earlier" button: reveal local past → page +5 through local past → flip label to **"Load older"** and extend the back edge by 90 days. `enrichWithRecurrenceContext` is unchanged; it just sees fewer rows. The no-window call signature still caps at 500 as belt-and-suspenders. (#57)

## [0.6.2] - 2026-05-21

### Added

- **Passkey authentication (Tier ≥1, gated off in prod).** Layered on top of OTP: AuthContext exposes `signInWithPasskey` / `registerPasskey` / `listPasskeys` / `renamePasskey` / `deletePasskey`. /login adds a "Sign in with a passkey" button + a post-OTP "Set up a passkey?" enrol card with **Skip** / **Don't ask again** affordances (the latter writes `plannen.passkey_enrol_opt_out` to localStorage so the prompt stops nagging). /profile gets a Passkeys management section (add / rename / delete). The Supabase client switches on `auth.experimental.passkey: true` outside Tier 0; Tier 0 throws a typed "not available in single-user local mode" error and hides the UI entirely. **Every surface is additionally gated behind `VITE_PASSKEYS_ENABLED` (default off)** so the UI stays hidden while Supabase finishes the server-side rollout of the passkey config PATCH on cloud projects (currently returns `HTTP 400 "Passkey configuration is not currently available"` even though the GET response exposes the four `passkey_*` / `webauthn_*` fields on the schema). Flip the flag on Vercel + redeploy once `npx plannen cloud passkeys enable` returns 200. (#51, #53)
- **`npx plannen cloud passkeys enable` CLI.** New subcommand under `cloud` that reads `PLANNEN_WEB_URL` from the active profile, derives the WebAuthn RP ID (strips `www.`) + canonical origin, and PATCHes the Supabase Auth config (`passkey_enabled`, `webauthn_rp_id`, `webauthn_rp_origins`, `webauthn_rp_display_name`) via the Management API. Idempotent: GETs current config, only PATCHes drifted fields. Refuses non-cloud_sb profiles; warns that the RP ID is effectively immutable once any user enrols. Also slots in as the `'enable-passkeys'` step of `plannen cloud provision` after `wire-auth`. (#51)

### Fixed

- **`plannen deploy` auto-link path crashed with `ReferenceError: require is not defined`.** The default linker fallback at `cli/commands/deploy.mjs:86` called `require('node:child_process').spawnSync(...)` inside an ES module. Latent because the tests inject `ctx.cli` and the typical user path runs from a checkout that already has `.vercel/` linked; triggered by running `npx plannen deploy --profile <name> --vercel-project=<name>` from a fresh worktree. Uses the already-imported `spawnSync` now, with a source-level regression test to catch any re-introduction. (#52)

## [0.6.1] - 2026-05-21

### Added

- **Installable PWA app.** Manifest + service worker + maskable icons + iOS meta tags; the app installs on Android via beforeinstallprompt and on iOS via "Add to Home Screen". A Download chip in the nav and an "Install app" row in the mobile hamburger menu both gate on `useInstallPrompt` so they auto-hide once installed, and let the user re-trigger the iOS instructions card on demand. (#49, #50)
- **Web Push notifications.** VAPID-signed subscriptions stored per (user, endpoint) in a new `push_subscriptions` table. Server-side push fan-out resolves recipients from group membership + event/story ownership, then dispatches via web-push. Wired into three client paths: RSVPs notify the event creator; event create/update notifies members of shared groups + selected users; story share notifies story-share recipients. Sender excluded, recipients deduped, push tags collapse repeated actions. iOS push requires home-screen install (16.4+); Android works once permission is granted. (#49, #50)
- **OTP login** alongside the magic link. After requesting a sign-in email, the login screen renders a 6–10 digit input (`autoComplete=one-time-code` for iOS Mail/Messages autofill) so users can paste the code instead of tapping the link on a different device.
- **Native share-sheet on event + story share modals.** "Share via…" button on mobile invokes `navigator.share`, falls back to the existing WhatsApp link on desktop.
- **Camera-first photo capture for event extraction.** `capture="environment"` opens the back camera directly on mobile — "see flyer, snap, done" — instead of the generic file picker. Cover-image input still allows gallery picks.
- **/share route receives Android Web Share Target payloads.** Manifest's `share_target` points at `/share`, which normalises title/text/url and redirects into the Create Event form pre-filled with the shared content.

### Fixed

- **Recipients couldn't see events shared with them.** The 0.6.0 family-as-group unification updated RLS on `event_rsvps` and `event_memories` to allow visibility via `user_in_event_group` / `user_in_event_shared_with_users`, but the matching SELECT policies on the `events` table itself were never added. Group members and directly-shared users saw the share-junction rows but got nothing back when supabase-js fetched the events. New migration adds both policies, mirroring the OR-clauses already on dependent tables. Backend regression test exercises both share paths from a recipient session.
- **`plannen migrate` on tier 2 was broken.** `supabase db push --project-ref` is no longer a valid flag combination (only `link` accepts `--project-ref`); the script now does `supabase link --project-ref <ref>` then `supabase db push --linked`. CI (`release-staging.yml`) dodged this by calling `db push --linked` directly, so only manual tier-2 migrations failed.
- **`plannen deploy` warns when local migrations aren't yet on the remote.** Reads `supabase/migrations/`, queries the project's `supabase_migrations.schema_migrations` via the Management API, and lists any pending versions before the Vercel push. Skips silently when API creds or the migrations directory are missing, never blocks the deploy. Catches the "frontend ships against the old schema" scenario that delayed PR #49's `push_subscriptions` migration on sb_prod.
- **Service worker simplified to eliminate intermittent stuck-loading.** Previous SW combined a NavigationRoute with a NetworkFirst 3s-timeout fallback to a precached shell, which could serve chunk hashes from an older deploy. New SW precaches the build, hooks push + notificationclick, and uses `skipWaiting` + `clients.claim` so a new SW takes over open pages immediately. A "Clear app cache + reload" button in Settings is the recovery valve for users with an older SW still resident.
- **deploy URL regex.** Tightened so quoted/JSON output doesn't leak `",` into `PLANNEN_WEB_URL`.

### Migrations

Applied to cloud (`sb_prod`) before merge:
- `20260520170000_push_subscriptions.sql`
- `20260521090000_events_shared_visibility.sql`

## [0.6.0] - 2026-05-20

### Changed

- **Family is no longer a special data model — it's just a group you can create.** Sharing collapses to one path: groups. The `events.shared_with_family` and `stories.shared_with_family` boolean columns are dropped; the `relationships.relationship_type` column is dropped (family/friend distinction was cosmetic after the unification); a new `story_shared_with_groups` table mirrors `event_shared_with_groups`, and a new `story_shared_with_users` table mirrors `event_shared_with_users` so stories can be shared with individual people too.
- **Tabs reorganised.** *My Family* and *My Friends* collapse into a single **My People** tab (one connections list, no family/friend visual split, merged events feed). *My Groups* stays as a separate tab — groups are the sharing primitive. Old `?view=family` / `?view=friends` URLs redirect to `?view=people`. Offline contacts (kids, partner without accounts) continue to live on the Profile page as `family_members`.
- **Discover is a sparkles icon next to Create Event.** The always-on Discover form is gone; clicking the icon opens a modal containing the same input + results. Without an AI key configured, the modal explains and links to AI Settings instead of being silently broken.
- **EventCard mobile layout overhauled.** Inline Share / WhatsApp / Edit / Invite icons collapse into the kebab menu on phones (`sm:hidden` inline, labelled entries inside the kebab) so the title isn't squeezed by five icons on a 320px screen.
- **Day-of-week added to all event dates** ("Wed, May 27, 2026" instead of "May 27, 2026").
- **Series sharing reachable in one tap.** Opening Share on a single session now shows a banner: "This is one session of a series. Share the whole series →". One click escalates the modal to the parent event and pre-ticks "Apply to all N sessions".
- **MyGroups + MyPeople feeds now actually populate.** `getGroupsEvents`, `getFamilyEvents`, `getFriendsEvents` in `viewService` were stubs returning `[]`; they're now real Tier-1 queries hitting `event_shared_with_groups` and `event_shared_with_users` via supabase-js.

### Fixed

- **`infinite recursion detected in policy for relation "friend_groups"` 500s** on every share-modal open. The cycle was pre-existing between `friend_groups` "Members can view their groups" and `friend_group_members` "Group owners can manage members"; replaced the offending sub-select with a `SECURITY DEFINER` helper (`plannen.user_owns_friend_group`).
- **Manage Groups member checkboxes silently no-op'd.** `getGroupMembers` / `addGroupMember` / `removeGroupMember` were v0 REST stubs; wired up real supabase-js implementations and surface errors instead of swallowing them.
- **Calendar-view day pane lost most actions.** `CalendarGrid` wasn't forwarding `showActions` / `onClone` / `onHashtagClick` to the inner `EventList`, so the kebab / clone / share / hashtag chips silently disappeared compared to Compact.
- **Sharing flashed "Loading events…" between save and refetch.** `loadEvents` set `loading=true` and the render blanked the timeline; gated the fallback on `loading && events.length === 0` (stale-while-revalidate) across MyFeed, MyPeople, MyGroups.
- **Cosmetic family/friend label appeared on a connection added before the unification.** Pickers and pending-request lists now read every accepted connection regardless of historical type.
- **Mobile-first sweep:** every touched input, button, and accordion header in Login, Settings, EventForm, AddPerson, RSVPButton, ProfileLocations / PersonalInfo / Interests & Goals / FamilyMembers / Facts / StoryLanguages, StoryReader, Today, and Profile reaches 44×44 px tap targets; modal titles truncate; series-share banner stacks on mobile.

### Migrations

Applied to cloud (`sb_prod`) in order:
- `20260520130000_unify_family_as_group.sql`
- `20260520140000_fix_friend_groups_rls_recursion.sql`
- `20260520150000_drop_relationship_type.sql`
- `20260520160000_story_shared_with_users.sql`

## [0.5.5] - 2026-05-20

### Changed

- **Story share UI simplified.** Stories now have a single owner-only **Share** button that opens a small modal with one "Share with family" checkbox — matching the events share pattern. The inline WhatsApp share link and the standalone Family/Private toggle have been removed.

### Fixed

- **Manage family / friends shows real names and emails.** `getMyFamily` / `getMyFriends` were returning rows with `email: null` / `full_name: null` from a stale "v0 REST has no users-by-id endpoint" caveat, so accepted members rendered as `Member <uuid-prefix>`. In Tier 1+ they now hydrate from `plannen.users` via the existing `"Users can view profiles of friends and family"` RLS policy. Tier 0 keeps the null fallback (no multi-user recipients).

## [0.5.4] - 2026-05-20

### Fixed

- **`Release to staging` GitHub Actions workflow no longer fails on every merge to main.** The workflow expected ~12 `STAGING_*` secrets and a provisioned staging Supabase + Vercel project, none of which exist yet, so step 1 (`supabase link --project-ref ""`) failed on every push. Auto-trigger on `push: main` is commented out; `workflow_dispatch` is preserved so the workflow can be fired manually once staging is provisioned.

## [0.5.3] - 2026-05-19

### Changed

- **Today tab hidden from UI.** The "Today" tab is removed from the dashboard navigation and the default landing view is now "My Plans". The `Today` component, `/today` deep link (`?view=today`), and `briefingService` remain intact — re-enabling is a one-line revert in `src/components/Navigation.tsx`. Daily briefings continue to work via `/plannen-today` in Claude Code.

## [0.4.2] - 2026-05-17

### Changed

- **`plugin/skills/plannen-core.md`** — new *Don't override a saved event from thin evidence* section. Saved Plannen events almost always come from authoritative sources (organiser email, club portal, in-person sign-up) that public web search doesn't index well. If a quick web search can't corroborate a saved event, the first hypothesis is "I'm searching wrong", not "the user's data is wrong". The agent must ask where the user got the info before proposing edits, and must not assume two similarly-named pages on the same organiser site describe the same event.
- **`plugin/skills/plannen-discovery.md`** — step 5 now requires aggressive extraction of seven fields per candidate (registration link, deadline, price, date, address, age range, language) with one follow-link allowed when the landing page is sparse. Missing fields render as `unknown` rather than guessed, and each result is shown as a compact block.

## [0.4.1] - 2026-05-17

### Fixed

- **Cloud MCP tool calls returned empty `-32603`.** Both `supabase/functions/mcp/server.ts` and `supabase/functions/_shared/db.ts` opened pg pools from `DATABASE_URL` — but on cloud, Supabase auto-injects `SUPABASE_DB_URL` instead. Connection string was empty, every `tools/call` failed at connect time. `tools/list` (which doesn't touch the pool) hid the issue. The fix reads `DATABASE_URL || SUPABASE_DB_URL` so Tier 0 / Tier 1 keep using their existing var while Tier 2 falls through to Supabase's auto-injected name.

## [0.4.0] - 2026-05-17

Tier 2 — Supabase Cloud + Vercel hosting + bootstrap automation. The OSS install ladder now covers all three tiers end-to-end:

- **Tier 0** — embedded Postgres (just Node 20+).
- **Tier 1** — local Supabase Docker (the original dev path).
- **Tier 2** — Supabase Cloud + cloud MCP + (optionally) Vercel-hosted web app.

A first-time Tier 2 user runs `bash scripts/bootstrap.sh --tier 2`, picks a project from a menu, pastes a DB password, and (on prompt) gets a working `https://<name>.vercel.app` URL with magic-link sign-in.

### Added

- **Tier 2 cloud deploy** (`scripts/bootstrap.sh --tier 2`). 11-step migration orchestrator: snapshot Tier 1 → link cloud project → push schema → expose `plannen` via PostgREST → restore data → rewrite Tier 1 storage URLs to cloud → upload photos → deploy edge functions → rewrite local `.env` + plugin manifest → wire Supabase Auth Site URL + Redirect URLs → verify cloud MCP. Resumable via `.plannen-tier2-progress`.
- **Cloud MCP** — `supabase/functions/mcp/` Deno Edge Function exposes Plannen's 37 tools over streamable HTTP at `https://<ref>.supabase.co/functions/v1/mcp` with bearer auth. The plugin manifest is rewritten to point at it; Claude Code / Desktop / any MCP-aware agent can reach it from anywhere.
- **Vercel hosting** (`bash scripts/vercel-deploy.sh`). Pushes `VITE_*` env vars to the linked Vercel project (non-interactive via `vercel env add` stdin), runs `vercel --prod`, parses the deployment URL. Optional prompt at the end of Tier 2 bootstrap. After deploy, calls Supabase Management API to set Auth Site URL to the stable production alias (e.g. `plannen.vercel.app`, not the per-deployment hash URL) and adds both URLs to the allow-list.
- **Interactive project picker** (`scripts/lib/cloud-project-picker.mjs`) — lists your Supabase Cloud projects via Management API, prompts on `/dev/tty`, emits JSON on stdout. Honours `--project-ref` for non-interactive CI.
- **Supabase Management API client** (`scripts/lib/supabase-mgmt.mjs`) — `readAccessToken` reads from env, file, or **macOS Keychain** (where `supabase login` actually stores the token on darwin). Exposes `listProjects`, `getAuthConfig`, `updateAuthConfig`, `setExposedSchemas`, `mergeAllowList`.
- **`cloud-doctor`** (`node scripts/cloud-doctor.mjs`) — health check for Tier 2: cloud reachable, MCP tools/list, plugin manifest, exposed `plannen` schema, Auth Site URL, photo parity. Each check skips cleanly when its inputs aren't available; failures print actionable hints.
- **Tier 1 → Tier 0 migration helper** (`scripts/migrate-tier.sh`) — one-command downgrade with pre-flight checks, per-table count diff, and `--yes` for destructive `~/.plannen/pgdata` wipe. From [PR #11](https://github.com/pariksheet/plannen/pull/11).
- **Backend indicator badge** — small pill bottom-right of every page shows whether the browser is talking to `local pg`, `local supabase`, or `cloud`. Click to expand to the full URL.
- **Reverse-restore** on `--tier 1` after Tier 2 — bootstrap detects the prior tier in `.env` and restores `.env.tier1.bak` + `plugin.json.tier1.bak`. Cloud project is left intact.
- **MCP bearer rotation** (`scripts/mcp-rotate-bearer.sh`) — generates a fresh token, sets the cloud secret, rewrites the local plugin manifest.

### Changed

- **`plugin/.claude-plugin/plugin.json`** is no longer tracked in git. Bootstrap copies `plugin.json.example` (Tier 0 stdio default) → `plugin.json` on first run; Tier 2 then rewrites it in place with the cloud URL + bearer.
- **`AuthContext` `emailRedirectTo`** uses `window.location.origin` instead of an unset `VITE_APP_URL`, so magic-link emails land on the correct host whether the user signed in locally or on Vercel.
- **`AppRoutes` `/ → /dashboard`** redirect preserves the URL hash so Supabase JS can consume `#access_token=...` even when Supabase falls back to Site URL.
- **`rewrite-config`** orchestrator step now also backs up and removes `.env.local` so `npm run dev` picks up cloud values after migration (Vite loads `.env.local` after `.env`, so it overrides).

### Fixed

- **MCP edge function bundler** — per-file `npm:` specifiers in `supabase/functions/mcp/deno.json`. The Supabase Edge bundler can't resolve sub-paths against `npm:` prefix mappings.
- **`supabase db push`** in the migration orchestrator — dropped the invalid `--project-ref` flag; `--linked` (default) targets the project linked by the prior `link` step.
- **Migration orchestrator resume** — captures the snapshot path after the snapshot step, decompresses `.sql.gz` on restore, and rehydrates `cloudSupabaseUrl` / API keys when the link step is already marked done.
- **Cloud MCP verify** — sends `Accept: application/json, text/event-stream` and parses SSE-framed JSON-RPC responses (the MCP streamable-HTTP spec).
- **`cloud-doctor`** — `/auth/v1/health` now requires an `apikey` header on hosted Supabase; cloud-doctor sends it.
- **Story / memory images on mobile** — the migration rewrites `event_memories.media_url` and `stories.cover_url` values pointing at `http://127.0.0.1:54321/storage/v1/object/public/` to use the cloud storage URL. Without this, images resolved on the developer's own machine (Tier 1 still up) but not from a phone.

### Security / hygiene

- Personal identifiers scrubbed from test fixtures and an example in the design spec.

## [0.2.0] - 2026-05-14

Tier 0 storage model. Plannen now runs on a fresh machine with **just Node 20+** — no Docker, no Supabase CLI. The existing local-Supabase path (now called Tier 1) stays fully supported via `bash scripts/bootstrap.sh --tier 1`.

### Added

- **Tier 0 — embedded Postgres** (`embedded-postgres` started by Node on port 54322). New user runs one command (`bash scripts/bootstrap.sh`) and gets the full app, MCP, and web UI without any container runtime.
- **Tier-aware bootstrap** — `scripts/bootstrap.sh --tier 0|1` (default 0). Tier 0 path skips Docker/Supabase prereqs, inits embedded pg, applies migrations (Tier-0 compat overlay + main schema), inserts the user row, builds + starts the new Node backend, optionally starts the web dev server. Auto-restores `supabase/seed.sql` and `supabase/seed-photos.tar.gz` if present on a fresh DB.
- **Plannen backend** (`backend/`) — Hono + `@hono/node-server` mirror of Supabase's surface: `/api/{events,memories,stories,profile,relationships,locations,sources,watch,rsvp,groups,wishlist,settings,agent-tasks,me}`, `/storage/v1/object/event-photos/*`, `/functions/v1/{12 handlers}`, `/health`. Talks to Postgres via `pg.Pool` + `withUserContext(userId)` GUC helper.
- **Pure handler architecture** — all 12 Supabase edge functions extracted to `supabase/functions/_shared/handlers/<name>.ts` with shape `(req, {db, userId}) => Response`. Same handler code runs under Deno (Tier 1) and Node (Tier 0); each runtime entry verifies its own auth and opens its own pg client. Deno entries verify Supabase JWTs via `jose`; the `_shared/ai.ts` BYOK wrapper takes a handler ctx instead of a Request.
- **Web `dbClient` factory** (`src/lib/dbClient.ts`) — domain-keyed (`dbClient.events.list()`, `dbClient.memories.uploadFile(...)`, etc.) with two implementations: `tier1.ts` wraps `@supabase/supabase-js`, `tier0.ts` uses `fetch` against the local backend. 16 services in `src/services/*` now route through it. Contract test asserts both tiers expose the same surface.
- **Tier-0 AuthContext** — no login UI, no Supabase Auth round-trip; the backend resolves the user at boot from `PLANNEN_USER_EMAIL` and exposes them via `GET /api/me`.
- **Realtime polling fallback** — `useStories` switches from Postgres Realtime to a 30s `setInterval` in Tier 0.
- **Lifecycle umbrellas** — `scripts/start.sh` (`--no-dev` for headless / MCP-only) and `scripts/stop.sh` read `PLANNEN_TIER` and bring up / shut down the right stack. README documents a copy-paste macOS LaunchAgent for autostart on login.
- **Cross-tier backup/restore** — `scripts/export-seed.sh` is tier-aware: Tier 0 uses a pure-Node table dumper (`scripts/lib/dump-tables.mjs`) so a Homebrew pg_dump@16 doesn't choke on embedded pg 18+. `scripts/restore-photos.sh` likewise branches to a Node extractor (`scripts/lib/restore-photos.mjs`) that flattens Supabase Storage's `<file>/<version-uuid>` layout into the flat layout Tier 0 serves.
- **CI** — `.github/workflows/tier-0-bootstrap.yml` runs `bootstrap.sh --tier 0` from scratch on every PR that touches migrations, scripts, backend, or web data-layer files, then runs mcp + backend + handler + dbClient-contract tests and a Playwright smoke.

### Changed

- **`mcp/src/index.ts`** drops `@supabase/supabase-js`; uses `pg.Pool` + `withUserContext` against `DATABASE_URL`. All 38 tool handlers wrap their bodies in `withUserContext(userId, ...)` so `auth.uid()` resolves correctly under either tier.
- **`withUserContext`** sets both `app.current_user_id` (Tier 0 stub) and `request.jwt.claim.sub` (Tier 1 real) GUCs so the same client code works across tiers without runtime branching.
- **`scripts/bootstrap.sh`** prerequisite checks now skip Docker + Supabase CLI when Tier 0 (default).
- **`docs/TIERED_DEPLOYMENT_MODEL.md`** rewritten around the storage-tier axis (Tier 0/1/2/3+). The previous "publish/social-layer" tier idea folds into a future feature flag, orthogonal to storage.
- **`docs/INTEGRATIONS.md`** (new) — explicit separation of *integrations* (Google Calendar, Photos, Drive) from *tiers* (where Postgres + photos live).

### Fixed

- Tier 0 SQL overlay (`supabase/migrations-tier0/`) creates the `postgres`/`anon`/`authenticated`/`service_role` roles + `auth`/`storage`/`extensions` schemas + `auth.uid()` stub *before* the main migrations apply, so the squashed initial schema compiles cleanly against embedded pg.
- `pg`-driver type parser for `DATE` (OID 1082) now returns `YYYY-MM-DD` strings so `<input type=date>` accepts them without a re-format step.
- MCP env loading was racing the ESM import hoist (db.ts read `DATABASE_URL` before `loadDotenv()` ran). Moved the dotenv call into a side-effect module imported first; MCP now works with any `claude mcp add` env block as long as the repo `.env` exists.

### Notes

- Tier 0 is single-user by design. Cross-user/family/friends event feeds, group sharing, and friend-of-friend invites are still Tier-1 only — Tier 0 services degrade gracefully (empty lists, no-op writes) and the spec acknowledges this as a deliberate v0 scope.
- Existing Tier 1 users: nothing breaks. `bash scripts/bootstrap.sh --tier 1` keeps the Docker + Supabase path. Your `.env` and Docker volumes are untouched on upgrade.

## [0.1.0] - 2026-MM-DD

Initial public release. Plannen ships as a local-first AI planner that learns your preferences and turns events into memories, licensed under [AGPL-3.0](LICENSE).

### Added

- **Web app** — React + Vite calendar UI for events, family members, locations, RSVPs, memories, and stories.
- **MCP server** — single-file TypeScript wrapper that lets Claude Code and Claude Desktop read and write a local Plannen instance via Supabase.
- **Claude Code plugin** — installable via `/plugin install ./plugin`, bundling MCP registration, workflow skills (event-creation intent gate, profile extraction, source analysis, watch monitoring, story composition, photo organisation, discovery), and slash commands.
- **Slash commands** — `/plannen-doctor`, `/plannen-setup`, `/plannen-write-story`, `/plannen-organise-photos`, `/plannen-discover`, `/plannen-check-watches`, `/plannen-backup`.
- **BYOK AI keys** — per-user Anthropic API key stored in the local Supabase `user_settings` table, used server-side by edge functions; never sent on requests.
- **Bootstrap script** — `scripts/bootstrap.sh` performs a one-command first-run install: prereq checks, npm install, supabase start, migrations, auth-user creation, env-file generation, and optional plugin install.
- **Backup tooling** — `scripts/export-seed.sh` writes `supabase/seed.sql` and `supabase/seed-photos.tar.gz`; `scripts/restore-photos.sh` rebuilds storage objects with the xattrs the Supabase storage worker expects.
- **Google Photos integration** — picker-based attachment of photos to events via the Photos Library API.
- **Google Calendar sync** — outbound sync candidates surfaced via `get_gcal_sync_candidates`.
- **Stories** — AI-generated narratives for past events, multi-language (English, Marathi, Dutch by default).
- **Watch monitoring** — periodic re-check of saved event sources for date/registration changes.
- **CI** — GitHub Actions workflow runs web and MCP tests + builds on every PR (Linux + Node 20).
- **Contributor docs** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue and PR templates.

[Unreleased]: https://github.com/pariksheet/plannen/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/pariksheet/plannen/releases/tag/v0.8.1
[0.4.1]: https://github.com/pariksheet/plannen/releases/tag/v0.4.1
[0.4.0]: https://github.com/pariksheet/plannen/releases/tag/v0.4.0
[0.2.0]: https://github.com/pariksheet/plannen/releases/tag/v0.2.0
[0.1.0]: https://github.com/pariksheet/plannen/releases/tag/v0.1.0
