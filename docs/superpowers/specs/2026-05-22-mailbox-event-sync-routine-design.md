# Mailbox Event Sync Routine — Design

**Date:** 2026-05-22
**Status:** Approved, ready for implementation plan

## Problem

Event-worthy information (bookings, bills, club notices, ticket purchases, concert announcements) arrives by email and never lands in Plannen unless the user remembers to forward it to `/plannen`. The user wants a routine that scans the inbox throughout the day and writes events/reminders into Plannen, then syncs them to Google Calendar, without supervision.

## Goals

- Continuous, low-supervision ingestion of event-worthy email into Plannen.
- Same-run propagation to Google Calendar so the user's existing GCal stays the read surface for other family members.
- Single-user friendly to deploy today (runs on the user's Mac), but designed so additional mailboxes (Outlook, iCloud Mail, IMAP) and a future hosted variant can plug in without rewriting the core.
- A dismissal path so noisy recurring senders can be silenced without code changes.

## Non-goals

- Replying to emails. The routine only reads.
- Threading/attachment-aware NLP beyond what the AI Gateway gives us for free.
- Multi-tenant SaaS deployment in v1. The routine is local-cron only; the hosted Vercel-cron variant is future work.

## Decisions (all confirmed in brainstorm)

| Decision | Choice |
|---|---|
| Email scope | Full LLM scan of all new email — no allowlist |
| Action mode | Auto-commit every candidate; low-confidence items get a `#review` hashtag |
| Modify/cancel handling | Auto-apply matched changes; also tag `#review` |
| GCal sync | Same run as Plannen writes |
| Runtime | Local cron via macOS launchd |
| Cadence | Hourly between 06:00 and 23:00 Europe/Brussels (18 runs/day) |
| Notifications | Silent on success; macOS push on failure |
| LLM | Haiku 4.5 default; escalate to Sonnet 4.6 only on borderline-long body |
| Dismissal | Single-sender mute (no subject patterns) |

## Architecture

```
+-------------------+     +---------------------+     +---------------------+
| launchd (hourly)  | --> | claude -p           | --> | /plannen-mailbox-   |
|                   |     |   "/plannen-...-"   |     |  sync skill prompt   |
+-------------------+     +---------------------+     +----------+----------+
                                                                  |
                                                                  v
                                                    +-------------+--------------+
                                                    | Mailbox adapter registry   |
                                                    |   - gmail (only initial)   |
                                                    |   - icloud (future)        |
                                                    |   - imap   (future)        |
                                                    +-------------+--------------+
                                                                  |
                                                                  v
                                                    +-------------+--------------+
                                                    | For each enabled adapter:  |
                                                    |  1. list_unprocessed       |
                                                    |  2. for each message:      |
                                                    |     - check ignore rules   |
                                                    |     - classify (Haiku 4.5) |
                                                    |     - match to Plannen     |
                                                    |     - create/update/cancel |
                                                    |  3. mark_processed         |
                                                    +-------------+--------------+
                                                                  |
                                                                  v
                                                    +-------------+--------------+
                                                    | get_gcal_sync_candidates   |
                                                    | → GCal create_event x N    |
                                                    | → set_gcal_event_id        |
                                                    +----------------------------+
```

### Mailbox adapter contract

Every adapter exposes the same interface:

```
adapter.id                                # "gmail" | "icloud" | "imap" | ...
adapter.list_unprocessed(since, limit)    # → [{ message_id, sender, date, subject, body? }]
adapter.fetch_body(message_id)            # → full body text (lazy; classifier asks only if needed)
adapter.mark_processed(message_id)        # idempotency lock — Gmail: apply `plannen-ingested` label
adapter.mark_ignored(message_id)          # belt-and-braces — Gmail: apply `plannen-ignore` label
```

The core routine never branches on adapter type — it calls the contract. Adding iCloud or IMAP later is a new file + one line in the registry.

### Gmail adapter (v1 implementation)

- `list_unprocessed`: Gmail search `newer_than:7d -in:sent -in:draft -from:me -label:plannen-ingested -label:plannen-ignore`. Returns thread metadata only (no body) for cheap pre-classification.
- `fetch_body`: `get_thread(id, format=FULL_CONTENT)` when the classifier flags `needs_body=true`.
- `mark_processed`: `label_thread` applying `plannen-ingested`. Creates the label on first run if missing.
- `mark_ignored`: same, with `plannen-ignore`.

Both labels are user-visible in Gmail so the user can audit/correct without leaving Gmail.

### Cross-adapter dedupe

When the same event arrives in two adapters (e.g. an Arenal booking forwarded to a second inbox), the matcher catches the duplicate by sender + date + venue against existing Plannen events. The second occurrence becomes an update (likely a no-op identical payload) and the source message is still marked processed in its own adapter. Net result: one event, both messages cleared.

### Per-adapter failure isolation

Each adapter's `list_unprocessed` call is wrapped in try/catch with two retries (exponential backoff: 2s, 8s). On final failure, the routine continues with the remaining enabled adapters and emits a single grouped notification at the end naming the failing adapters.

## Email classification

The classifier is a single Haiku 4.5 prompt that takes message metadata + (optional) body and returns a structured JSON:

```jsonc
{
  "event_worthy": true,             // false → skip, label processed, done
  "needs_body": false,              // if true and body not yet fetched, fetch + reclassify
  "confidence": "high" | "low",
  "operation": "create" | "modify" | "cancel",
  "match_hints": {                  // used when operation = modify | cancel
    "sender": "noreply@arenal.be",
    "date": "2026-05-23",
    "venue": "Arenal Mechelen"
  },
  "event": {                        // for create / modify
    "title": "...",
    "start_date": "2026-05-23T05:00:00Z",   // always UTC `Z`
    "end_date":   "2026-05-23T06:30:00Z",
    "location": "...",
    "description": "...",
    "event_kind": "event" | "reminder",
    "event_status": "going" | "interested" | "watching" | "cancelled",
    "hashtags": [ ... ]
  }
}
```

### Confidence rules

- **High**: explicit booking confirmation, formal meeting invite, ticket purchase with concrete date + venue, club notice with date+place, bill with explicit due date.
- **Low**: vague dates ("in May"), promotional concert announcements without commitment, recruiter pitches mentioning availability windows, anything where extraction guessed a field.

Low-confidence candidates still create events — they just gain a `#review` hashtag the user can filter by in Plannen.

### Timezone enforcement

The classifier emits `start_date` / `end_date` as UTC with a `Z` suffix, computed from the Brussels-local time it inferred. This avoids the bug observed in earlier sessions where naive timestamps were stored 2h ahead.

### Body-fetch budget

`needs_body=true` triggers a `get_thread(FULL_CONTENT)` call and a re-classification. The classifier flags this only when the snippet doesn't contain enough to extract the event (e.g. SNCB tickets with the date inside the PDF). Cap: one body fetch per message per run.

## Matching existing events (modify / cancel)

For `operation` in `modify | cancel`:

1. Query Plannen: `list_events(from_date=match_date-1d, to_date=match_date+1d, limit=50)`.
2. Filter to events whose `location` contains `match_hints.venue` OR `description` mentions `match_hints.sender`.
3. Cases:
   - **Exactly one match** → apply the update (status change for cancel, field updates for modify), append `#review`.
   - **Zero matches** → fall back to `operation=create`; tag `#review` because the email implied a prior event we couldn't find.
   - **>1 match** → create a new `#review` event annotating the change in description; do not touch the originals. Surface this in the optional summary log.

## Dismissal (single-sender mute)

### Data model

```sql
create table mailbox_ignore_rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  adapter_id      text not null,
  sender          text not null,
  source_event_id uuid references events(id) on delete set null,
  source_message_id text,
  reason          text,
  hit_count       int not null default 0,
  last_hit_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, adapter_id, sender)
);

alter table mailbox_ignore_rules enable row level security;
create policy "rls_own_rules" on mailbox_ignore_rules
  for all using (auth.uid() = user_id);
```

### Layer A — UI dismissal

When the user deletes/cancels an event that has `#review` or `#mbsync` in its hashtags, the Plannen UI presents:

> *Dismissed. Mute future emails from `<sender>`?*  
> **[Just this one] [Mute this sender]**

`Mute this sender` writes a row to `mailbox_ignore_rules` and calls `adapter.mark_ignored` on the source message so it never re-enters even on a fresh cold-start.

### Layer B — Routine enforcement

At the start of every run the routine fetches all rules for the user once, indexed by `(adapter_id, sender)`. For each pulled message, before classification:

```
if (adapter_id, sender) in rules:
    rule.hit_count += 1
    rule.last_hit_at = now()
    adapter.mark_processed(message_id)
    continue
```

The classifier never sees a muted message → no token spend.

### Layer C — Gmail-native escape hatch

Applying the `plannen-ignore` label to any thread (manually or via a Gmail filter) skips it. Layer A also applies this label so the two paths converge.

### Undo

A new `/plannen mailbox rules` slash command lists current ignore rules with a quick delete. Deleting a rule also unlabels the source thread in Gmail (if known).

### Source-event linkage

Auto-created events get a marker hashtag `#mbsync` in addition to their content hashtags. The source message ID is stored at the start of the event description as `Gmail-ID: <id>` (until a proper metadata column exists). This is what the UI uses to know "this event was created by the routine, offer the dismiss prompt."

## Failure handling

| Condition | Behaviour |
|---|---|
| Single message classification fails | Skip the message, leave unlabelled, count toward run-failure threshold |
| Gmail API call fails after retries | Surface in run summary, continue other adapters |
| sb_prod (Plannen DB) unreachable | Abort the run before writes, push notification, no Gmail labels applied |
| AI provider returns `no_provider_configured` / `invalid_api_key` | Abort, push notification quoting the BYOK error message |
| Lock file present (previous run still alive) | Exit silently |
| Three consecutive runs end with errors | Push a sustained-failure notification (separate text from per-run alerts) |

Notifications use `osascript -e 'display notification "<text>" with title "Plannen mailbox sync"'`.

### Concurrency lock

`/tmp/plannen-mailbox-sync.lock` holds the PID. Acquired with `flock` at run start; released on exit (including crash via a `trap` in the launchd wrapper script). launchd's `ThrottleInterval=3600` provides a second guard against double-firing.

## launchd configuration

File: `~/Library/LaunchAgents/work.plannen.mailbox-sync.plist`

Key fields:
- `Label`: `work.plannen.mailbox-sync`
- `ProgramArguments`: `[ "/bin/bash", "-lc", "<wrapper script>" ]` — wrapper handles flock, env, logging, exit codes
- `StartCalendarInterval`: 18 entries, `Hour: 6…23`, `Minute: 0`
- `ThrottleInterval`: `3600`
- `EnvironmentVariables`:
  - `PLANNEN_PROFILE`: `prod` (or whatever the user's active profile is at install)
  - `PATH`: includes the user's Node/Claude binaries
- `StandardOutPath`: `~/.plannen/logs/mailbox-sync.log`
- `StandardErrorPath`: `~/.plannen/logs/mailbox-sync.err`
- `RunAtLoad`: `false` (don't fire on every login)

The wrapper script:
1. Acquires the lock via `flock -n`.
2. Rotates logs older than 7 days.
3. Runs `claude -p "/plannen-mailbox-sync"`.
4. On non-zero exit, emits the macOS notification.

Install/uninstall is handled by two new CLI verbs:
- `npx plannen mailbox install` — writes the plist, runs `launchctl bootstrap`, verifies, prints status.
- `npx plannen mailbox uninstall` — `launchctl bootout` + removes the plist.

## LLM model selection

- **Default**: `claude-haiku-4-5-20251001`. Classification is structured-output extraction — Haiku's strength. Cost per run dominated by message count, expected ~$0.001–0.003.
- **Escalation**: Sonnet 4.6 (`claude-sonnet-4-6`) only when the classifier reports `confidence=low` AND body length >4k tokens AND `operation` in `modify|cancel`. This is the situation where misclassification creates real cleanup work (wrong cancellation), so the extra spend is justified.
- Both calls go through Vercel AI Gateway using the existing BYOK key, so quota is shared with other Plannen AI features.

## Slash command surface

- `/plannen-mailbox-sync` — the routine itself (also invoked by launchd).
- `/plannen mailbox status` — show last run time, success/failure counts, queued messages.
- `/plannen mailbox rules` — list/delete `mailbox_ignore_rules`.
- `/plannen mailbox install` / `uninstall` — manage launchd plist.

## Data model changes

1. **New table `mailbox_ignore_rules`** as described above. Forward-only migration timestamped after the current head.
2. **No schema change to `events`** in v1. The source message ID lives at the top of `description`. If the auto-ingestion proves valuable, a follow-up migration adds `events.source_provider`, `events.source_id` proper columns.
3. **No new RLS policies** beyond the one on `mailbox_ignore_rules`. The routine writes events under the user's JWT just like the MCP plugin does.

## Out of scope (future work)

- **Hosted Vercel-cron variant** that works while the Mac is asleep. Needs the same logic ported into an edge function with persistent Gmail OAuth tokens server-side.
- **iCloud Mail / Outlook adapters.** The contract is ready for them; v1 ships only Gmail.
- **Per-event metadata columns** (`source_provider`, `source_id`). Defer until the description-prefix heuristic shows friction.
- **Smart cross-event consolidation** (merging Arenal "booking confirmed" with later "you're in!" join confirmations into a single richer event). The matcher in v1 just calls them duplicates.
- **Summary digest UI** showing what the routine did in the last 24h. The Plannen feed + the `#review` filter already covers the immediate need.

## Risks

| Risk | Mitigation |
|---|---|
| Misclassified email creates a wrong event | Low-confidence path tags `#review`; user can filter and clean up. |
| Mac asleep → routine misses runs | Acceptable for v1 (Mac is usually on for morning + evening windows). Hosted variant is the long-term answer. |
| Token cost creep at 18 runs/day | Ignore-rules elide muted senders before classification; most runs see 0–3 candidates. Estimated ceiling $5/mo. |
| Gmail label namespace collision | Labels are scoped under the user's own Gmail; `plannen-ingested` and `plannen-ignore` are unlikely to clash with anything. |
| Mute too coarse (single sender swallows wanted mails) | `/plannen mailbox rules` makes rule removal trivial; muted patterns are visible. |
| sb_prod outage during a run | Routine aborts before any Gmail label is written, so the next run reprocesses cleanly. |

## Open questions

None blocking. The Vercel-cron variant remains a separate future spec.
