# Mailbox Sync Rework — Design

**Date**: 2026-05-27
**Status**: Approved for implementation planning
**Scope**: Fix the mailbox sync's false-positive rate, give users an in-app way to mute, and broaden the rule expressivity beyond single senders.

## Problem

The current `/plannen-mailbox-sync` routine creates events for mass-marketing emails it shouldn't (NT2 Festival 2026, EVCO Xperience Days, ACME policy renewals, cold recruiter outreach). The cause is structural, not a one-off prompt bug:

1. **Classifier hedges via `#review`** — borderline emails get created with `#mbsync #review` tags instead of being skipped, which produces clutter the user never reviews.
2. **No in-app provenance** — `#mbsync` and `Gmail-ID:` prefix exist but are buried in the description; the user can't tell a sync-created event from a manual one without opening the modal and reading carefully.
3. **No mute UX** — to stop a sender, the user must invoke MCP tools or hand-edit the database; nothing in the web UI.
4. **Mute rules are single-sender-only** — the schema enforces `UNIQUE(user_id, adapter_id, sender)`. One row per from-address. Marketing campaigns rotate addresses (`noreply+ab12@…`, `campaigns@e.acmelife.com`); legitimate senders mix useful and useless mail. The unit is too narrow.

## Decisions

| Axis | Decision |
|---|---|
| Cadence | Hourly 06–23 → every 4h around the clock (00, 04, 08, 12, 16, 20 Brussels) |
| Classifier | Keep `#review` tag, tighten the prompt with explicit mass-marketing exclusions + "addressed to me" check |
| Provenance | Card-level `<Mail>` icon on `#mbsync` events + Source section in modal showing sender + actions |
| Rule unit | Three explicit kinds: `sender` (current), `domain`, `domain_subject` |
| Mute click | Defaults to mute + delete current event; "Also delete" checkbox is on by default with an override |
| Retroactive | After rule add, show matching `#mbsync` events with default-checked checkboxes; user picks |

What's explicitly NOT in scope: replacing the launchd + Claude-Code-slash-command architecture with a backend cron job. That's a follow-on if cloud users need it.

## Architecture (deltas)

```
                                            ┌────────────────────────┐
                                            │  /plannen-mailbox-sync │
                                            │  (Haiku, launchd-run)  │
                                            └───────────┬────────────┘
                                                        │ Step A: rules check (JS)
                                                        │ Step E: create_event +
                                                        │         add_event_provenance
                                                        ▼
                  ┌───────────────────────────────────────────────────────────────┐
                  │                       Plannen DB                              │
                  │                                                               │
                  │   plannen.mailbox_ignore_rules                                │
                  │     ├─ kind        sender | domain | domain_subject           │
                  │     ├─ pattern     (renamed from `sender`)                    │
                  │     └─ subject_keyword                                        │
                  │                                                               │
                  │   plannen.event_provenance (NEW, sidecar to events)           │
                  │     ├─ source            'mailbox' | …                        │
                  │     ├─ sender_email      lowercased addr@host                 │
                  │     ├─ sender_domain     lowercased host                      │
                  │     └─ subject                                                │
                  │                                                               │
                  │   plannen.ignore_rule_matches(...)  ── SQL helper             │
                  └───────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ ignoreRules.{list,add,delete}
                                              │ events.getProvenance
                                              │ events.findMatchingMbsync
                                              │
                  ┌───────────────────────────────────────────────────────────────┐
                  │                       Web UI                                  │
                  │                                                               │
                  │   EventCard          → small <Mail> icon iff #mbsync          │
                  │   EventDetailsModal  → Source section + [Mute…] button        │
                  │   MuteSyncDialog     → kind radio + delete-current checkbox   │
                  │   SweepMatchesDialog → checklist of retroactive matches       │
                  └───────────────────────────────────────────────────────────────┘
```

## Component-by-component

### 1. Cadence

`cli/lib/launchd-plist.mjs` — the `for (h=6; h<=23; h++)` loop becomes a fixed array `[0, 4, 8, 12, 16, 20]`. `ThrottleInterval: 3600` and `RunAtLoad: false` stay. Anyone with an installed plist re-runs `npx plannen mailbox install` to pick up the new schedule.

CHANGELOG line + a one-time `>&2` warning emitted by `sync-wrapper.sh` if `launchctl print` shows the old 18-hour schedule.

### 2. Classifier prompt

`plugin/skills/plannen-mailbox-sync.md` Step B grows:

**New "Skip outright" categories** (additions to the existing list):

- **Mass marketing even with date+venue** — public ticketed festivals (NT2 Festival, museum openings, food fairs), commercial product launches (EVCO Xperience Days, car-brand "experience days"), brand events with public CTAs ("Book your seat", "Discover more"). Tell-tales: greeting is generic ("Dear customer", "Hi there"); no booking ID/thread reference; sender is a brand mailing infrastructure (`noreply@…`, `news@…`, `events@…`, `e.<brand>.com` subdomains).
- **Cold recruiter outreach** — even with a proposed meeting time. Tell-tales: no prior thread, generic "introductory chat / catch-up" framing, no shared employer in From/To headers, recruiter signature.
- **Transactional renewals & policy reminders** — ACME, insurance, mobile plans, subscriptions, anything with subject containing "renewal / due / expires / autopay / policy / KYC". They have dates but are chores, not events.
- **Generic public event invites with no addressed recipient** — `to:` is a list address or the user is BCC'd; greeting is generic; "all welcome" framing.

**New "addressed to me" check** — for any candidate event-worthy email, the agent must answer: *"Does this email greet the user by name, or reference something specific they did/own (a booking ID, a thread they started, a child's name)?"* If no, the email only stays event-worthy when the subject is unambiguously a personal commitment ("Your appointment confirmed", "Booking #ABC123 — pickup details").

**`#review` semantics tightened** — `#review` now means "personally addressed but I missed at least one of (date, venue/link, future, addressed to user)". Bulk marketing no longer reaches `#review` — it's outright-skipped. Zero additional API calls; all signals are in the snippet + headers already returned by `search_threads`.

### 3. Schema — `mailbox_ignore_rules` expansion

New forward-only migration: `supabase/migrations/<timestamp>_mailbox_ignore_rules_richer.sql`.

```sql
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
```

Existing rows survive with `kind='sender'` (column default) — zero behavioral change for already-installed mutes.

**Match function** — used by both the retroactive sweep (SQL WHERE) and unit-tested independently:

```sql
CREATE OR REPLACE FUNCTION plannen.ignore_rule_matches(
  rule_kind text, rule_pattern text, rule_subject text,
  email_from text, email_subject text
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  email_addr text;
  email_domain text;
BEGIN
  email_addr := lower(coalesce(
    substring(email_from from '<([^>]+)>'),
    email_from
  ));
  email_domain := split_part(email_addr, '@', 2);

  IF rule_kind = 'sender' THEN
    RETURN email_addr = lower(rule_pattern);
  ELSIF rule_kind = 'domain' THEN
    RETURN email_domain = lower(rule_pattern)
        OR email_domain LIKE '%.' || lower(rule_pattern);
  ELSIF rule_kind = 'domain_subject' THEN
    RETURN (email_domain = lower(rule_pattern)
            OR email_domain LIKE '%.' || lower(rule_pattern))
       AND lower(coalesce(email_subject, '')) LIKE '%' || lower(rule_subject) || '%';
  ELSE
    RETURN false;
  END IF;
END;
$$;
```

The agent's Step A mirrors this logic in JS so the per-thread classification loop stays pure (no extra MCP roundtrip per email).

**Sweep query helper** — used by `find_matching_mbsync_events` MCP tool and by Tier 1/2 web via supabase-js RPC:

```sql
CREATE OR REPLACE FUNCTION plannen.find_matching_mbsync_events(
  rule_kind text, rule_pattern text, rule_subject text
) RETURNS SETOF plannen.events LANGUAGE sql STABLE AS $$
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
```

`SECURITY INVOKER` (the default) — runs as the calling user, so RLS on `events` and `event_provenance` applies. `auth.uid()` works for Tier 1/2 Supabase; for Tier 0 the equivalent is set via `withUserContext` (per `mcp/src/db.ts`).

### 4. Schema — `event_provenance` (new sidecar)

Same migration file or one alongside it:

```sql
CREATE TABLE plannen.event_provenance (
  event_id          uuid PRIMARY KEY REFERENCES plannen.events(id) ON DELETE CASCADE,
  source            text NOT NULL,            -- 'mailbox' for now
  adapter_id        text,                     -- 'gmail'
  source_message_id text,                     -- Gmail thread id
  sender_display    text,                     -- raw "Name <addr@host>"
  sender_email      text,                     -- lowercased addr@host
  sender_domain     text,                     -- lowercased host
  subject           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plannen.event_provenance ENABLE ROW LEVEL SECURITY;

-- SELECT: anyone who can see the parent event can see its provenance.
-- (Mirror the event_notes pattern.)
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

-- INSERT/UPDATE/DELETE: only the event's creator can write provenance for it.
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

CREATE INDEX idx_event_provenance_sender_domain ON plannen.event_provenance (sender_domain);
```

Index on `sender_domain` because the sweep matches by domain most often.

**No backfill for old `#mbsync` events.** The Source section degrades to "Source unknown — Gmail thread ID: `<id>`" for events created before this migration. The mute dialog falls back to a single sender text input.

### 5. MCP tool surface

Both `mcp/src/index.ts` (Tier 0 stdio) and `supabase/functions/mcp/tools/mailbox.ts` (Tier 1/2 HTTP) gain or change:

- **`add_ignore_rule`** — signature change:
  - **Old**: `{ adapter_id, sender, source_event_id?, source_message_id?, reason? }`
  - **New**: `{ adapter_id, kind: 'sender'|'domain'|'domain_subject', pattern, subject_keyword?, source_event_id?, source_message_id?, reason? }`
  - Server validates: `subject_keyword` is required iff `kind === 'domain_subject'`, forbidden for the others. Trim + lowercase `pattern` before insert.

- **`list_ignore_rules`** — unchanged signature; response shape gains `kind`, `pattern`, `subject_keyword`. Existing rows return `kind: 'sender'`.

- **`find_matching_mbsync_events`** (new) — args: `{ kind, pattern, subject_keyword? }`. Returns event rows where `'mbsync' = ANY(hashtags)` AND `plannen.ignore_rule_matches(...)` returns true against the joined `event_provenance`. SELECT only. Limited to 100 results (matches in the wild shouldn't approach this).

- **`add_event_provenance`** (new) — args: `{ event_id, source, adapter_id?, source_message_id?, sender_display?, sender_email?, sender_domain?, subject? }`. INSERT … ON CONFLICT (event_id) DO UPDATE. Used by the sync agent's Step E.

- **`get_event_provenance`** (new) — args: `{ event_id }`. Returns the row or null. Used by the web modal.

### 6. REST surface (Tier 0 backend)

New files under `backend/src/routes/api/`:

- **`mailbox-ignore-rules.ts`** — `GET /` (optional `adapter_id` query), `POST /` (mirrors the MCP shape), `DELETE /:id`. Same auth-scoping pattern as `event-notes.ts`.
- **`event-provenance.ts`** — `GET /?event_id=…` (returns row or 404), `POST /` (upsert). Visibility check identical to event-notes (SELECT 1 FROM events WHERE id = … AND created_by = $user).

Wired into `backend/src/index.ts` next to the other routes.

### 7. Web dbClient

`src/lib/dbClient/types.ts` gains:

```ts
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

And the `DbClient` interface gains:

```ts
ignoreRules: {
  list: (params?: { adapter_id?: string }) => Promise<IgnoreRuleRow[]>
  add: (input: {
    adapter_id: string
    kind: IgnoreRuleKind
    pattern: string
    subject_keyword?: string | null
    source_event_id?: string | null
    source_message_id?: string | null
    reason?: string | null
  }) => Promise<IgnoreRuleRow>
  delete: (id: string) => Promise<void>
  findMatchingMbsyncEvents: (spec: {
    kind: IgnoreRuleKind
    pattern: string
    subject_keyword?: string | null
  }) => Promise<EventRow[]>
}

events.getProvenance: (eventId: string) => Promise<EventProvenanceRow | null>
```

`tier0.ts` implements via the new REST endpoints. `tier1.ts` implements via supabase-js — `.from('mailbox_ignore_rules')` for CRUD, and `findMatchingMbsyncEvents` via `supabase.rpc('find_matching_mbsync_events', { rule_kind, rule_pattern, rule_subject })` against the Postgres function from Section 3. Contract tests in `src/lib/dbClient/contract.test.ts` cover both tiers against the same interface.

### 8. Sync agent prompt — Step A & Step E

**Step A** rewrite:

> For each thread:
> 1. Extract `from_email`, `from_domain`, `subject` from the first message.
> 2. For each ignore rule in `rules`:
>    - If `kind === 'sender'`: match iff `from_email === pattern`.
>    - If `kind === 'domain'`: match iff `from_domain === pattern` OR `from_domain` ends with `.` + `pattern`.
>    - If `kind === 'domain_subject'`: match iff the domain condition AND `subject.toLowerCase().includes(subject_keyword.toLowerCase())`.
> 3. First match wins → call `bump_ignore_rule_hit({id: rule.id})`, advance `latestProcessedAt`, count as `muted`. Continue.

**Step E** addition (after `create_event` returns):

```
mcp__plannen__add_event_provenance({
  event_id, source: 'mailbox', adapter_id: 'gmail',
  source_message_id: thread.id,
  sender_display: <raw From: header>,
  sender_email, sender_domain,
  subject: thread.subject,
})
```

If `add_event_provenance` fails, **do not** abort — the event is still useful, the Source section just degrades. Log the failure into the run report's `errors` array.

### 9. Web UI

**`EventCard.tsx`** — add `<Mail className="h-3.5 w-3.5 text-gray-400" />` inline with the hashtag chip row when `event.hashtags?.includes('mbsync')`. `title="Added by mailbox sync"`. No layout reshuffle; no behavior change on click.

**`EventDetailsModal.tsx`** — new optional section between the existing info block and the RSVP block, rendered iff `event.hashtags?.includes('mbsync')`:

```tsx
<div className="pt-4 border-t border-gray-200">
  <div className="flex items-start gap-2 text-sm">
    <Mail className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" />
    <div className="flex-1 min-w-0">
      <p className="font-medium text-gray-700">Added by mailbox sync</p>
      {provenance ? (
        <p className="text-gray-600">From: {provenance.sender_display}</p>
      ) : (
        <p className="text-gray-500 italic">Source unknown</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {provenance?.source_message_id && (
          <a href={`https://mail.google.com/mail/u/0/#inbox/${provenance.source_message_id}`}
             target="_blank" rel="noopener noreferrer"
             className="text-sm text-indigo-600 hover:underline">
            View original email
          </a>
        )}
        <button onClick={() => setMuteOpen(true)}
                className="min-h-[44px] px-3 py-1 text-sm rounded-md border border-gray-300 hover:bg-gray-50">
          Mute…
        </button>
      </div>
    </div>
  </div>
</div>
```

Provenance is fetched lazily via `useEffect` keyed on `event.id` when the modal opens (only if it's a `#mbsync` event).

**`MuteSyncDialog.tsx`** (new) — modal with radio group, "Also delete" checkbox, Mute/Cancel actions. Default selection: `domain`. Subject input pre-fill: `subject.split(/\s+/).find(w => w.length > 3 && !/^[\d\-]+$/.test(w)) ?? ''`. On submit:

1. Call `dbClient.ignoreRules.add(...)` with the chosen `kind`/`pattern`/`subject_keyword` and `source_event_id: event.id`, `source_message_id: provenance.source_message_id`.
2. If "Also delete" is checked, call `dbClient.events.delete(event.id)` and close the parent modal.
3. Open the sweep dialog with the spec just used.

When provenance is missing (legacy `#mbsync` event without a sidecar row): the radio group degrades — only `sender` is offered, and the user types the address into a text input. `domain` and `domain_subject` are hidden because we don't have the metadata to pre-fill them.

**`SweepMatchesDialog.tsx`** (new) — opens after the rule is created. On mount, calls `dbClient.ignoreRules.findMatchingMbsyncEvents(spec)`. Renders the result as a checklist; checkboxes default-checked. "Delete selected" issues `dbClient.events.delete(...)` in parallel; "Keep all" closes. If the result is empty, the dialog never opens.

## Testing

| Layer | Test | Location |
|---|---|---|
| SQL | `ignore_rule_matches` cases (all kinds, edge cases: `Name <addr>` parsing, subdomain, case) | new pgTAP-style file under `supabase/migrations/` or a `.test.sql` companion |
| SQL | Migration back-compat: pre-existing row reads as `kind='sender'` after migration | as above |
| MCP | `add_ignore_rule` validation; `find_matching_mbsync_events` excludes non-mbsync; `add_event_provenance` upsert | `supabase/functions/mcp/tools/mailbox.test.ts` (extend) |
| REST (Tier 0) | CRUD on `mailbox-ignore-rules`; GET/POST on `event-provenance`; auth scoping | `backend/src/routes/api/mailbox-ignore-rules.test.ts` and `event-provenance.test.ts` |
| dbClient contract | Both tiers honor the new interface members | `src/lib/dbClient/contract.test.ts` (extend) |
| Web | `EventCard` icon visibility on/off; `EventDetailsModal` Source section render with/without provenance; `MuteSyncDialog` submit shape; `SweepMatchesDialog` checkbox-driven delete | new Vitest files alongside the components |
| Classifier prompt | Manual fixture suite — 10 representative emails with expected verdicts; run by hand when the prompt changes | `docs/superpowers/specs/mailbox-sync-fixtures.md` (companion file, not yet written) |

The classifier prompt regression is **not** gated CI — LLM-eval-on-CI tooling isn't worth the build for solo use. The fixture file makes regression visible to whoever next edits the prompt.

## Rollout

Single PR, single forward-only migration file. Merge order is implicit in file dependencies — Postgres applies migrations in filename order; everything else lands in the same commit on `feat/mailbox-sync-rework`.

Post-merge user action: re-run `npx plannen mailbox install` to pick up the new cadence. Wrapper emits a one-time stderr warning if `launchctl print gui/$UID/work.plannen.mailbox-sync` shows the old 18-hour schedule.

## Backwards compatibility

1. **Existing ignore rules**: zero data migration. `kind` defaults to `sender`, `pattern` is the renamed column. The agent's Step A treats them as exact-sender matches — identical to today.
2. **Existing `#mbsync` events without provenance**: Source section reads "Source unknown — Gmail thread ID: `<id>`"; mute dialog falls back to the `sender`-only radio with a manual text input.
3. **Installed launchd plist**: re-install required for the new schedule. Wrapper warns; CHANGELOG calls it out.
4. **`/plannen-mailbox-rules` slash command**: unchanged externally — the list/delete flow still works. The render table can later be enriched to show `kind` and `subject_keyword`, but isn't required by this design.

## Out of scope

- Replacing launchd with a backend cron (Vercel cron / Supabase Edge Function on a schedule). Future work.
- Other adapters (IMAP, Apple Mail, Outlook). Future work.
- Auto-rule-suggestion from event-delete behavior ("you deleted 3 events from `@acmelife.com` — mute them all?"). Listed as a follow-on idea but not in this design.
- LLM-eval-on-CI for the classifier prompt. Manual fixtures only.
- Subject regex / multi-keyword rules. `domain_subject` uses one keyword + `ILIKE %...%`. Sufficient for the cases driving this design.
