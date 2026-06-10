---
description: Walks through one /plannen-mailbox-sync run — pull mail from every enabled adapter, classify, write to Plannen, sync to GCal. Loaded by the /plannen-mailbox-sync slash command; do not invoke standalone.
---

# Plannen Mailbox Sync — Routine

You are executing one iteration of the mailbox sync routine. The user is not watching this run — you must finish or fail cleanly without prompting.

Progress is tracked by a per-adapter **checkpoint** (`last_synced_at`) stored in Plannen, not by Gmail labels. Each run reads the checkpoint, processes everything newer, and advances it to the internal date of the latest successfully-handled thread. Failures leave the checkpoint untouched so the next run retries the same window.

## Adapters

For v1 only Gmail is enabled. The adapter contract is:

| Capability | Gmail implementation |
|---|---|
| `list_unprocessed` | `mcp__claude_ai_Gmail__search_threads` with query `<windowFilter> -in:sent -in:draft -from:me`, `pageSize: 50`. `<windowFilter>` is `after:<unix>` (checkpoint + 1s) when a checkpoint exists, otherwise `newer_than:7d` on first run. |
| `fetch_body`       | `mcp__claude_ai_Gmail__get_thread` with `messageFormat: FULL_CONTENT`. |

Each message carries an implicit `adapter_id = "gmail"` through the whole pipeline. No Gmail write scope is required.

## Pre-flight

1. Call `mcp__plugin_plannen_plannen__list_ignore_rules({adapter_id: "gmail"})` → keep the result in memory as `rules`. Index by `normaliseSender(rule.sender)` (lowercase + strip display name).

2. Call `mcp__plugin_plannen_plannen__get_mailbox_sync_state({adapter_id: "gmail"})`.
   - If `last_synced_at` is non-null: parse it, compute `unix = Math.floor(Date.parse(last_synced_at) / 1000) + 1`, and use `after:<unix>` as the window filter. Initialise `latestProcessedAt = last_synced_at`.
   - If null (first ever run): use `newer_than:7d` as the window filter. Initialise `latestProcessedAt = null`.

3. Track `latestProcessedAt` for the whole run. Every successfully-handled thread (create, modify, cancel, mute-skip, outright-skip) updates it via `latestProcessedAt = max(latestProcessedAt, max(message.internalDate on the thread))`. Convert Gmail's `internalDate` (ms since epoch as string) to an ISO timestamp for storage.

## Per-message pipeline

For each thread returned by `list_unprocessed`:

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

### Step B — Classification

Read the snippet + headers. Decide:

- **Skip outright** — newsletters, promotional blasts, CI failure emails, OTP/sign-in links, daily creche journals, GCal echoes of events already in Plannen, password resets, recruiter cold pitches with no concrete meeting proposed, marketing announcements without dates+venues, payment receipts for past transactions, dispute resolutions, threads already concluded ("I chose another option"), **mass marketing with date+venue (public ticketed festivals, brand "experience" events, commercial product launches — tell-tales: generic greeting like "Dear customer", sender on a brand mailing subdomain, CTA like "Book your seat / Discover more")**, **cold recruiter outreach even with a proposed time (tell-tales: no prior thread, generic "introductory chat" framing, no shared employer in headers)**, **transactional renewals & policy reminders (ACME-style — subject contains "renewal / due / expires / autopay / policy / KYC")**, **developer/admin platform notices about API deprecations, migrations, breaking changes, version sunsets, or compliance deadlines (tell-tales: subject contains "deadline / deprecation / sunset / migration / breaking change / EOL / end of life / phase out / discontinued"; sender is a SaaS platform you use as a developer rather than a venue you visit; the email is a chore reminder, not something you attend in person — Supabase API deadlines, AWS service retirements, npm package deprecations all fall here)**, **generic public event invites where the user is BCC'd or `to:` is a list address with generic greeting**. Outright-skip still advances `latestProcessedAt`; count as `skipped`.

- **Event-worthy** — set `confidence` to `high` only if you have all four of: a concrete date, a venue/place (or "remote" with a meeting link), the email is **addressed to the user personally** (greets by name, references a booking ID / thread / child's name / something only-they-would-know), and the date is in the future or today. Otherwise `low` confidence. Bulk marketing that happened to slip through Skip-outright but fails the addressed-to-me check is now treated as a skip, **not** routed to `#review`. `#review` is reserved for emails that ARE personally addressed but missing one of the other criteria.

- **needs_body** — set to `true` and call `get_thread(FULL_CONTENT)` once if the snippet doesn't yield a date/venue but the subject suggests an event (ticket purchases, formal invitations, club notices). Cap at one body fetch per thread per run.

Decide `operation`:

- `create` — default; the email describes a new event/reminder.
- `modify` — email implies an existing event changed (rescheduled, room changed).
- `cancel` — email explicitly cancels something.

Decide `event_kind` (creates only) — first match wins:

- **`event`** — you need to be present at a specific time/place, or join a scheduled call. Tell-tales: appointment, meeting, class/session, party, trip, booking, ceremony, oudercontact; a venue or meeting link is given; the email is about *attending*. Give it a `start_date` (and `end_date` when known).
- **`todo`** — the email asks *you* to complete a discrete, checkable action by or on a date. Tell-tale verbs: pay, book/reserve, register/enrol, RSVP/confirm by, submit, fill in, renew, upload, sign, return, bring. All-day on the action's due date. **Also** use `todo` when an email is clearly event-worthy and personally addressed but its date/time is locked in an attachment the run can't read (`bijlage`, "see attached", a PDF invite): title it `"<subject> — open attachment"`, date it on the message date (so it surfaces as actionable/overdue, not a fake calendar slot), add `review`, and put `"Couldn't read the attachment — open the original to confirm the date and act."` in the description.
- **`reminder`** — a dated heads-up with no attendance and nothing for you to complete: pure awareness. Tell-tales: bin/waste collection, "school closed", "package arriving", "registration opens on…", "don't forget X is tomorrow", informational deadline notices. All-day or point-in-time.

Boundary rule: a deadline to *do* something → `todo`; a deadline that's purely informational (nothing for you to do) → `reminder`. When an email describes an event you attend AND a distinct "confirm/pay/book by" action, create the `event`; add a separate `todo` only if that action has its own deadline worth tracking on its own.

### Step C — Matching (only for `modify` / `cancel`)

Call `mcp__plugin_plannen_plannen__list_events({from_date: matchDate - 1d, to_date: matchDate + 1d, limit: 50})`.

Filter the returned events to those where `location` contains the hinted venue OR `description` mentions the hinted sender.

- **Exactly one match** → call `update_event` with the new fields; ensure `event_status` becomes `cancelled` for cancels; append `review` to hashtags (max 5 — if at cap, replace the oldest non-`mbsync` tag).
- **Zero matches** → degrade to `create` and add `review` (the email implied a prior event we couldn't find).
- **Multiple matches** → do not touch the originals. Create a new `review`-tagged event whose description starts with `Ambiguous match — check originals. Gmail-ID: <id>`.

### Step D — Dedupe check (creates only)

Before each `create_event`, call `list_events({from_date: eventDate - 1d, to_date: eventDate + 1d, limit: 50})`. Run two checks against the returned rows, in order.

**D.1 — Same-thread dedupe (self-healing, edit-proof).** A prior run may already have turned this thread — or a sibling thread for the same real-world event — into an event. Check structurally first, then fall back to description text.

First build `thread_msg_ids`: the set of Gmail message/thread IDs this email comprises — `thread.id` plus any sibling-thread IDs you've identified as the same event (the IDs you would otherwise record as `Also in:` because the delivery/confirmation email quotes or references an earlier thread). Identify these *before* deciding to create, so a merge can resolve to an existing event instead of a new one.

1. **Provenance match (authoritative).** For each candidate row in the window, call `mcp__plugin_plannen_plannen__get_event_provenance({event_id: row.id})`. If a row's `source_message_id` is in `thread_msg_ids`, that row IS the canonical event for this thread — a prior run already created it. Do NOT `create_event`. If this email contributes a *new* sibling ID not already linked on the row, append `Also in: Gmail-ID: <id>` to its description via `update_event`; otherwise just advance `latestProcessedAt`. Count as `skipped`. **This survives the user renaming the event or clearing/editing its description**, because it reads the structural `event_provenance` row, not description text — which is exactly the gap that let an edited event get re-ingested as a duplicate.
2. **Description-prefix fallback.** If no provenance row matched (provenance can be missing on older events or fail to record), scan each row's `description` for the prefix `Gmail-ID: <thread.id>`. (The summary form truncates at 200 chars, well past the prefix.) Same outcome: treat as already-done, advance `latestProcessedAt`, count as `skipped`.

**D.2 — Same-event semantic dedupe.** A single real-world event often produces multiple emails from different senders (booking from the organiser, calendar invite, reminder, waitlist confirmation, parent forwarding the details). They land in separate Gmail threads, so D.1 doesn't catch them. Run this fuzzy match against each candidate row in the returned window:

1. **Date gate** — the existing event's `start_date` must fall on the SAME calendar day as the candidate (compare year/month/day in Europe/Brussels). Drop everything else.
2. **Token overlap** — let `candidate_tokens` = lowercase tokens from the candidate's title (split on whitespace and punctuation), excluding tokens with length ≤ 2 and the stopword set `{at, the, and, for, with, from, into, your, this, that, our, you, are, all, new}`. Compute the same for each surviving existing row.
3. **Score the candidate vs each existing row.** Award 1 point per shared title token (max 3 from titles), 1 point if `candidate_location` is non-empty AND appears as a substring of `existing.location` (or vice versa), 1 point if any shared title token appears in `existing.description` (catches participant names like "Milo" mentioned in the prior email's body).
4. **Verdict.**
   - Score ≥ 2 against any existing row → treat as a duplicate. Do NOT `create_event`. Append a one-line entry to the existing event's description ("Also in: Gmail-ID: <thread.id>") via `update_event` so the second thread is at least linked. Advance `latestProcessedAt`. Count as `skipped_dedupe`.
   - Score 1 against any row → ambiguous. Proceed with `create_event` but ALSO add `review` to the new event's hashtags so the user can confirm or merge later.
   - Score 0 against every row → proceed with a normal `create_event`.

Worked example (the inline-skating triplicate that motivated this rule):
- Existing event: title `"Milo — Inline skating — Session 8"`, location `"RolclubNoord"`, start `2026-06-15`.
- Candidate: title `"Kids Cup - Inline skating at RolclubNoord"`, location `"RolclubNoord"`, start `2026-06-15`.
- Shared title tokens: `inline`, `skating`, `rolclubnoord` → 3 points (capped). Location substring match → 1 point. Total 4 → skip + link.

This makes the routine self-healing across crashes and user edits (D.1 — structural provenance lookup, not description text) AND avoids one real-world event producing N parallel Plannen events from N senders (D.2).

### Step E — Writing to Plannen

For creates:

```
mcp__plugin_plannen_plannen__create_event({
  title, start_date (UTC `Z`, computed from Brussels-local time),
  end_date  (UTC `Z`, or omit),
  location, description (must start with `Gmail-ID: <thread.id>\n\n`),
  event_kind: "event" | "reminder" | "todo",   // see "Choosing event_kind" in Step B
  event_status: "going" | "interested" | "watching" | "cancelled",
  hashtags: [ ...up to 5; always include "mbsync"; include "review" when confidence=low ],
})
```

Timezone rule: always emit `Z`-suffixed UTC for `start_date`/`end_date`. Brussels in CEST = UTC+2; in CET = UTC+1.

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

### Step F — Advance checkpoint

After a successful write (or any clean skip / mute), update `latestProcessedAt = max(latestProcessedAt, max(message.internalDate on the thread))`.

If the write throws, do NOT update `latestProcessedAt`. See "Failure handling" below.

## After the per-message loop

1. If `latestProcessedAt` advanced beyond the run's starting value, call `mcp__plugin_plannen_plannen__set_mailbox_sync_state({adapter_id: "gmail", last_synced_at: latestProcessedAt})`. If `latestProcessedAt` is unchanged (zero threads in the window), skip this call.
2. Call `mcp__plugin_plannen_plannen__get_gcal_sync_candidates`.
3. For each candidate, call `mcp__claude_ai_Google_Calendar__create_event` with `timeZone: candidate.gcal_timezone` and `startTime: candidate.gcal_start` (local datetime, no offset).
4. Call `mcp__plugin_plannen_plannen__set_gcal_event_id({event_id, gcal_event_id})` for each.

## Failure handling

- Wrap each adapter's `list_unprocessed` in a try block. On error: retry twice with `setTimeout(2000)` then `setTimeout(8000)`. After final failure, record the adapter name and move on. Do not advance the checkpoint for that adapter.
- If `mcp__plugin_plannen_plannen__list_events` or `create_event` throws with a connection-style error, abort the run immediately. Do not call `set_mailbox_sync_state`. The next run will retry the same window.
- If the Plannen MCP returns a BYOK error (`no_provider_configured` / `invalid_api_key` / `rate_limited` / `provider_unavailable` / `model_unavailable`), abort and surface the error code in the final report. Do not advance the checkpoint.

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
- Do not call any Gmail write tools (`label_thread`, `unlabel_thread`, `label_message`, `unlabel_message`, `create_label`, `delete_label`, `update_label`). Read-only Gmail scope is sufficient under the checkpoint model.
- **Do not invoke `Bash`, `Read`, `Write`, `Edit`, or any built-in tool.** The only tools you may use are the `mcp__claude_ai_Gmail__*` read tools (`list_labels`, `search_threads`, `get_thread`), `mcp__claude_ai_Google_Calendar__*`, and `mcp__plugin_plannen_plannen__*` MCP tools listed above. In particular: never invoke `scripts/mailbox/sync-wrapper.sh`, never re-invoke `claude -p`, never run yourself recursively. The wrapper script is the entry point that called you; you do not call it.
