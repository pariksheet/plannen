# Event Subject Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an event be attributed to a person other than the account owner (a family member or a connected friend) so it renders on the owner's calendar but does not raise the `⚠ overlaps` clash badge — unless the owner also attends.

**Architecture:** Add a polymorphic subject (`subject_kind` + `subject_id`) and an `owner_attends` boolean to `plannen.events`. The web clash detector (`overlappingIds`) and the day-plan briefing treat an event as the owner's busy time only when `subject_id IS NULL` OR `owner_attends = true`. Attribution is set agent-side from natural language; a name chip is shown on the card. Both MCP servers (local Node + Deno edge) gain matching `create_event`/`update_event` params and return the new columns. The web reads events via `select('*')`, so new columns flow through once the `Event` type lists them.

**Tech Stack:** PostgreSQL (Supabase), TypeScript, Node `pg` (local MCP), Deno (edge MCP), React + Vitest (web), the Plannen plugin skill.

**Spec:** `docs/superpowers/specs/2026-06-12-event-family-attribution-design.md`

**Conventions for every commit message:** end with
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## File map

- **Create:** `supabase/migrations/20260613120000_event_subject_attribution.sql` — schema columns + pair constraint.
- **Modify:** `src/types/event.ts` — add three fields to `Event`.
- **Modify:** `src/utils/weekAgenda.ts:89` — `overlappingIds` filter clause (web-only, NOT engine-parity mirrored).
- **Modify:** `src/utils/weekAgenda.test.ts` — new clash tests.
- **Modify:** `src/components/ScheduleOverview.tsx` — `subjectNames` prop + name chip.
- **Modify:** `src/components/ScheduleOverview.test.tsx` — chip test.
- **Modify:** `src/components/MyFeed.tsx` — build `subjectNames` map from family members + relationships, pass it down.
- **Modify:** `mcp/src/index.ts` — `createEvent`/`updateEvent` handlers, `slimEvent`, `SLIM_EVENT_COLUMNS`, `listEvents` SELECT, `events_today`/`events_tomorrow` SELECT in `get_briefing_context`, `create_event`/`update_event` tool schemas.
- **Modify:** `supabase/functions/mcp/tools/events.ts` — mirror of the createEvent/updateEvent handlers + tool schemas.
- **Modify:** `supabase/functions/mcp/tools/_shared.ts` — mirror of `slimEvent` + `SLIM_EVENT_COLUMNS`.
- **Modify:** `supabase/functions/mcp/tools/briefings.ts` — mirror of `events_today`/`events_tomorrow` SELECT.
- **Modify:** `supabase/functions/mcp/tools/events.test.ts` — round-trip test for the new params.
- **Modify:** `plugin/skills/plannen-core/SKILL.md` (or the intent-gate skill file) — agent guidance for setting the subject + `owner_attends`.

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260613120000_event_subject_attribution.sql`

> Latest existing migration is `20260612120000_obligations.sql`; this timestamp sorts after it. Forward-only, additive — never edit the squashed initial schema.

- [ ] **Step 1: Write the migration**

```sql
-- Event subject attribution: an event can represent someone else's busy time.
-- subject_kind/subject_id is a polymorphic pointer (no FK, app-resolved, same
-- convention as events.assigned_to): NULL = the owner's own event; otherwise the
-- referenced person is the busy one. owner_attends = the owner also occupies this
-- time (so it still clashes). See
-- docs/superpowers/specs/2026-06-12-event-family-attribution-design.md
alter table plannen.events
  add column subject_kind  text
    check (subject_kind in ('family_member', 'user')),
  add column subject_id    uuid,
  add column owner_attends boolean not null default false;

-- subject_kind and subject_id are set together or not at all.
alter table plannen.events
  add constraint events_subject_pair
    check ((subject_kind is null) = (subject_id is null));
```

- [ ] **Step 2: Apply on the active Tier-0 profile**

> Back up first per CLAUDE.md. Tier 0: tar `~/.plannen/pgdata` + `~/.plannen/photos`, or `bash scripts/export-seed.sh` on Tier 1.

Run: `npx plannen migrate`
Expected: migration `20260613120000_event_subject_attribution` reported as applied, no error.

- [ ] **Step 3: Verify the columns exist**

Run:
```bash
psql "postgresql://postgres:postgres@localhost:54322/postgres" -c "\d+ plannen.events" | grep -E "subject_kind|subject_id|owner_attends"
```
Expected: three rows — `subject_kind | text`, `subject_id | uuid`, `owner_attends | boolean ... not null default false`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260613120000_event_subject_attribution.sql
git commit -m "feat(db): add event subject attribution columns (subject_kind/id, owner_attends)"
```

---

## Task 2: Web `Event` type

**Files:**
- Modify: `src/types/event.ts:30`

- [ ] **Step 1: Add the fields to the `Event` interface**

In `src/types/event.ts`, immediately after the `assigned_to?: string | null` line (line 30), add:

```ts
  subject_kind?: 'family_member' | 'user' | null
  subject_id?: string | null
  owner_attends?: boolean
```

- [ ] **Step 2: Typecheck**

Run: `npm run build` (or `npx tsc --noEmit`)
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/event.ts
git commit -m "feat(web): add subject attribution fields to Event type"
```

---

## Task 3: `overlappingIds` exclusion (TDD)

**Files:**
- Modify: `src/utils/weekAgenda.test.ts:99` (append inside the existing `describe('overlappingIds', …)` block)
- Modify: `src/utils/weekAgenda.ts:89-91`

`overlappingIds` is defined only here and is **not** an engine-parity mirror, so this is a single-file change.

- [ ] **Step 1: Write the failing tests**

In `src/utils/weekAgenda.test.ts`, add these two tests just before the closing `})` of the `describe('overlappingIds', …)` block (after the reminder test that ends at line 98):

```ts
  it("excludes a subject event the owner isn't attending — it never clashes", () => {
    const ids = overlappingIds([
      ev({ id: 'mine', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'kid', subject_kind: 'family_member', subject_id: 'fm1', owner_attends: false,
           start_date: '2026-06-10T11:30:00', end_date: '2026-06-10T12:30:00' }),
    ])
    expect(ids.size).toBe(0)
  })

  it('includes a subject event when the owner attends — it clashes normally', () => {
    const ids = overlappingIds([
      ev({ id: 'mine', start_date: '2026-06-10T11:00:00', end_date: '2026-06-10T12:00:00' }),
      ev({ id: 'swim', subject_kind: 'family_member', subject_id: 'fm1', owner_attends: true,
           start_date: '2026-06-10T11:30:00', end_date: '2026-06-10T12:30:00' }),
    ])
    expect(ids).toEqual(new Set(['mine', 'swim']))
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/weekAgenda.test.ts -t overlappingIds`
Expected: the first new test FAILS (`kid` currently clashes → set size 1-2, not 0). The "owner attends" test happens to pass already (it has no exclusion yet), which is fine.

- [ ] **Step 3: Add the filter clause**

In `src/utils/weekAgenda.ts`, change the filter on line 91 from:

```ts
    .filter((e) => e.event_kind !== 'reminder' && e.start_date.length > 10)
```

to:

```ts
    .filter((e) =>
      e.event_kind !== 'reminder' &&
      (e.subject_id == null || e.owner_attends) && // a subject's event isn't the owner's busy time unless they attend
      e.start_date.length > 10)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/weekAgenda.test.ts`
Expected: all `overlappingIds` and `buildWeekAgenda` tests PASS (including the 5 pre-existing overlap tests — back-to-back, all-day, reminder, etc.).

- [ ] **Step 5: Commit**

```bash
git add src/utils/weekAgenda.ts src/utils/weekAgenda.test.ts
git commit -m "feat(web): exclude non-attended subject events from clash detection"
```

---

## Task 4: Name chip on the schedule card

**Files:**
- Modify: `src/components/ScheduleOverview.tsx:18-31` (props) and the row render around `:544`
- Modify: `src/components/ScheduleOverview.test.tsx`

- [ ] **Step 1: Add the `subjectNames` prop**

In `src/components/ScheduleOverview.tsx`, add to `ScheduleOverviewProps` (after `obligationsToday?` on line 30):

```ts
  // Maps an event's subject_id → display name (family member or connected friend),
  // built by the parent (MyFeed) from already-loaded people. Used to label a chip
  // on events that represent someone else's time. Optional → no chip when absent.
  subjectNames?: Record<string, string>
```

- [ ] **Step 2: Thread the prop into the week rows**

The clash badge is rendered in the week-row `<span>` near line 544. Locate the existing block:

```tsx
{row.clash && (
  <span className="ml-1.5 text-[11px] not-italic whitespace-nowrap bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-1.5 py-0.5">
    ⚠ overlaps
  </span>
)}
```

Immediately **after** that block, add a subject chip:

```tsx
{row.event.subject_id && props.subjectNames?.[row.event.subject_id] && (
  <span className="ml-1.5 text-[11px] not-italic whitespace-nowrap bg-slate-100 text-slate-600 border border-slate-200 rounded-full px-1.5 py-0.5">
    {props.subjectNames[row.event.subject_id]}
  </span>
)}
```

> `row.event` is the `Event` already on each `WeekRow` (see the `overlappingIds(b.events)` usage at line 422). If the variable in scope is named differently, use the event object that the row renders.

- [ ] **Step 3: Add a chip test**

In `src/components/ScheduleOverview.test.tsx`, add a test that renders an event with `subject_id: 'fm1'` and `subjectNames={{ fm1: 'Milo' }}` for today, and asserts the chip text appears. Match the file's existing render helper and a today-dated event; the assertion is:

```tsx
expect(screen.getByText('Milo')).toBeInTheDocument()
```

(Use the same `render`/setup pattern already in this test file; reuse its event factory and "today" date constant rather than inventing new ones.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/components/ScheduleOverview.test.tsx`
Expected: PASS, including the new chip test and all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/components/ScheduleOverview.tsx src/components/ScheduleOverview.test.tsx
git commit -m "feat(web): show subject name chip on schedule events"
```

---

## Task 5: Build and pass `subjectNames` from MyFeed

**Files:**
- Modify: `src/components/MyFeed.tsx`

MyFeed already loads scheduling rows and renders `<ScheduleOverview …>`. It needs to load the people once and build an id→name map.

- [ ] **Step 1: Load family members + connected friends and build the map**

In `MyFeed.tsx`, where other dbClient data is loaded (alongside the attendances/obligations fetch already wired here), fetch family members and relationships and build a memoised map. Use the existing dbClient accessors:

```ts
// near the other useState/useEffect data loads in MyFeed
const [subjectNames, setSubjectNames] = useState<Record<string, string>>({})

useEffect(() => {
  let cancelled = false
  ;(async () => {
    const [members, friends] = await Promise.all([
      dbClient.familyMembers.list(),          // id, name
      dbClient.relationships.list().catch(() => []), // connected users: id, full_name
    ])
    if (cancelled) return
    const map: Record<string, string> = {}
    for (const m of members) map[m.id] = m.name
    for (const f of friends) map[f.id] = f.full_name ?? f.email ?? 'Friend'
    setSubjectNames(map)
  })()
  return () => { cancelled = true }
}, [])
```

> Confirm the exact dbClient method names by reading `src/lib/dbClient/types.ts` (family members are listed there; relationships may be exposed via a different accessor or via the MCP `list_relationships`). If a relationships accessor doesn't exist on the web dbClient, populate the map from family members only for this pass and leave a `// TODO friends` — the `'user'` subject kind still works the moment a names source exists, and the chip simply doesn't render without a name. Do NOT add a new backend endpoint here.

- [ ] **Step 2: Pass it to ScheduleOverview**

Find the `<ScheduleOverview … />` usage in `MyFeed.tsx` and add the prop:

```tsx
  subjectNames={subjectNames}
```

- [ ] **Step 3: Typecheck + run MyFeed-related tests**

Run: `npx tsc --noEmit && npx vitest run src/components/MyFeed`
Expected: no type errors; existing MyFeed tests still pass (the new prop is optional).

- [ ] **Step 4: Commit**

```bash
git add src/components/MyFeed.tsx
git commit -m "feat(web): wire subjectNames map from people into the schedule"
```

---

## Task 6: Local MCP server (`mcp/src/index.ts`)

**Files:**
- Modify: `mcp/src/index.ts` — lines 83 (`SLIM_EVENT_COLUMNS`), 85-101 (`slimEvent`), 120 (`listEvents` SELECT), 220-301 (`createEvent`), 303-344 (`updateEvent`), 2353/2361 (`events_today`/`events_tomorrow` SELECT), 2562-2611 (tool schemas).

- [ ] **Step 1: Add the columns to the slim projection**

Line 83 — append the three columns:

```ts
const SLIM_EVENT_COLUMNS =
  'id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, recurrence_rule, parent_event_id, completed_at, assigned_to, subject_kind, subject_id, owner_attends'
```

In `slimEvent` (after line 99 `assigned_to: …`), add:

```ts
    subject_kind: e.subject_kind ?? null,
    subject_id: e.subject_id ?? null,
    owner_attends: e.owner_attends ?? false,
```

- [ ] **Step 2: Return the columns from `listEvents`**

Line 120 SELECT — append `, subject_kind, subject_id, owner_attends`:

```ts
    const sql = `SELECT id, title, description, start_date, end_date, location, event_kind, event_status, hashtags, enrollment_url, enrollment_deadline, subject_kind, subject_id, owner_attends
                 FROM plannen.events
```

- [ ] **Step 3: Accept + insert the columns in `createEvent`**

Extend the args type (after `assigned_to?: string` on line 231):

```ts
  subject_kind?: 'family_member' | 'user'
  subject_id?: string
  owner_attends?: boolean
```

Change the INSERT column list and VALUES (lines 246-251) to add three columns. New column list:

```ts
      `INSERT INTO plannen.events
         (title, description, start_date, end_date, location, event_kind,
          enrollment_url, hashtags, event_type, event_status, created_by,
          assigned_to, shared_with_friends, recurrence_rule,
          subject_kind, subject_id, owner_attends)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, $11, 'none', $12, $13, $14, $15)
       RETURNING *`,
```

Add to the params array (after `args.recurrence_rule ?? null,` on line 264):

```ts
        args.subject_kind ?? null,
        args.subject_id ?? null,
        args.owner_attends ?? false,
```

> The DB `events_subject_pair` constraint rejects a half-set pair, so no extra app validation is needed; a bad combination surfaces as an insert error.

- [ ] **Step 4: Accept the columns in `updateEvent`**

`updateEvent` builds its SET clause generically from `rest`, so it only needs the fields admitted into its args type. Extend the args type (after `enrollment_url?: string` on line 311):

```ts
  subject_kind?: 'family_member' | 'user' | null
  subject_id?: string | null
  owner_attends?: boolean
```

No other change to the handler body — the generic loop emits `subject_kind = $n`, etc. The pair constraint enforces validity.

- [ ] **Step 5: Return the columns in the briefing event lists**

In `getBriefingContext`, both `events_today` (line 2353) and `events_tomorrow` (line 2361) SELECTs — append the three columns so the day-plan agent can tell whose time an event is:

```ts
          `SELECT id, title, start_date, end_date, location, event_kind, hashtags, subject_kind, subject_id, owner_attends
           FROM plannen.events
           WHERE created_by = $1 AND start_date::date = $2::date
```

(apply the identical column addition to both queries).

- [ ] **Step 6: Add the tool-schema params**

In the `create_event` tool schema (after the `assigned_to` property on line 2573), add:

```ts
        subject_kind: { type: 'string', enum: ['family_member', 'user'], description: "Whose time this event is, if not the owner's. 'family_member' → a family_members id; 'user' → a connected friend's user id. Set together with subject_id." },
        subject_id: { type: 'string', description: 'Id of the subject person (family member or connected user). Set together with subject_kind.' },
        owner_attends: { type: 'boolean', description: "True if the owner is also occupied during this event (so it still counts as a clash). Default false. Only meaningful when a subject is set." },
```

Add the same three properties to the `update_event` tool schema (after `enrollment_url` on line 2607).

- [ ] **Step 7: Build the local MCP server**

Run: `cd mcp && npm run build` (or the repo's MCP build script)
Expected: TypeScript compiles with no errors.

- [ ] **Step 8: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(mcp-local): subject attribution params on create/update_event + reads"
```

---

## Task 7: Edge MCP server (mirror)

**Files:**
- Modify: `supabase/functions/mcp/tools/_shared.ts:99,114-115` — `SLIM_EVENT_COLUMNS` + `slimEvent`.
- Modify: `supabase/functions/mcp/tools/events.ts` — tool schemas (66-126), `createEvent` (268-350), `updateEvent` (352-391).
- Modify: `supabase/functions/mcp/tools/briefings.ts` — `events_today`/`events_tomorrow` SELECTs.
- Modify: `supabase/functions/mcp/tools/events.test.ts` — round-trip test.

> Apply the SAME edits as Task 6 so the two servers stay in parity (`scripts/check-mcp-parity.mjs`).

- [ ] **Step 1: Mirror the slim projection in `_shared.ts`**

Line 99 — append `, subject_kind, subject_id, owner_attends` to `SLIM_EVENT_COLUMNS`. In `slimEvent` after line 115 (`assigned_to: e.assigned_to ?? null,`) add:

```ts
    subject_kind: e.subject_kind ?? null,
    subject_id: e.subject_id ?? null,
    owner_attends: e.owner_attends ?? false,
```

- [ ] **Step 2: Mirror `createEvent` in `events.ts`**

Extend the `a` cast type (after `assigned_to?: string` on line 276) with the three optional fields; add the three columns to the INSERT column list + VALUES `$13,$14,$15` (lines 296-301, mirroring Task 6 Step 3); add to the params array after `a.recurrence_rule ?? null,` (line 314):

```ts
      a.subject_kind ?? null,
      a.subject_id ?? null,
      a.owner_attends ?? false,
```

- [ ] **Step 3: Mirror `updateEvent` in `events.ts`**

Extend the `a` cast type in `updateEvent` (after `enrollment_url?: string` on line 361) with:

```ts
    subject_kind?: 'family_member' | 'user' | null
    subject_id?: string | null
    owner_attends?: boolean
```

(generic SET loop needs nothing else.)

- [ ] **Step 4: Mirror the tool schemas**

Add the same `subject_kind`/`subject_id`/`owner_attends` properties to the `create_event` schema (after `assigned_to`, line 77) and `update_event` schema (after `enrollment_url`, line 122), identical text to Task 6 Step 6.

- [ ] **Step 5: Mirror the briefing SELECTs in `briefings.ts`**

Find the `events_today` / `events_tomorrow` queries (same `SELECT id, title, start_date, end_date, location, event_kind, hashtags …` shape as the local server) and append `, subject_kind, subject_id, owner_attends` to each.

- [ ] **Step 6: Add a round-trip test in `events.test.ts`**

Add a test that calls `eventsModule.dispatch.create_event` with `subject_kind: 'family_member'`, `subject_id: <a uuid>`, `owner_attends: false`, then reads it back via `get_event` (or asserts on the create result) and expects those three fields echoed. Reuse the file's existing `ctx` test harness and the pattern from the `create_event rejects missing title` test (line 37).

- [ ] **Step 7: Run the edge tool tests**

Run: `npx vitest run supabase/functions/mcp/tools/events.test.ts`
Expected: PASS, including the new round-trip test and the existing tool-list test (line 11 — unchanged tool names).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/mcp/tools/_shared.ts supabase/functions/mcp/tools/events.ts supabase/functions/mcp/tools/briefings.ts supabase/functions/mcp/tools/events.test.ts
git commit -m "feat(mcp-edge): mirror subject attribution params + reads"
```

---

## Task 8: Parity + full test sweep

**Files:** none (verification only)

- [ ] **Step 1: MCP + engine parity**

Run: `npm run check:parity`
Expected: both `check-mcp-parity.mjs` and `check-engine-parity.mjs` report ✓ (the schemas/`slimEvent` match across servers; no engine-mirror symbol changed).

- [ ] **Step 2: Full web + CLI test suites**

Run: `npm test` and `npm run test:cli`
Expected: all green. If `check-mcp-parity` flags `create_event`/`update_event` schema drift, diff the two schema blocks and make them byte-identical.

- [ ] **Step 3: Commit (only if any fixups were needed)**

```bash
git add -A
git commit -m "test: fix parity/test drift for subject attribution"
```

---

## Task 9: Agent intent-gate guidance (plugin skill)

**Files:**
- Modify: `plugin/skills/plannen-core/SKILL.md` (the always-on event-creation intent-gate skill — confirm exact filename under `plugin/skills/`)

- [ ] **Step 1: Add subject-attribution guidance to the event-creation section**

In the event intent-gate section of the skill, add a paragraph (adapt wording to the surrounding voice, use generic personas only — no real names):

```markdown
**Whose event is it.** When an event clearly belongs to someone other than the
account owner — "Milo's sports day", "the kids' dentist", "Sam's recital" —
resolve that person and set the event's subject so it doesn't falsely block the
owner's calendar:
- Search `list_family_members` first, then accepted relationships via
  `list_relationships`. Pass `subject_kind` ('family_member' or 'user') and
  `subject_id` to `create_event`.
- Set `owner_attends: true` only when the owner is also occupied for the whole
  event ("I take Milo to swimming and wait"). For drop-and-leave or
  just-tracking ("Milo has swimming Tuesdays"), leave it false — the default.
  When it's genuinely unclear, default to false (don't nag the owner with
  overlap warnings).
- A subject event with `owner_attends: false` is excluded from the owner's clash
  detection, so don't also warn about overlaps for it.
```

- [ ] **Step 2: Confirm no personal data**

Run: `git diff plugin/skills/` and verify only generic personas appear (CLAUDE.md hard rule — repo is public).

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/
git commit -m "docs(plugin): intent-gate sets event subject + owner_attends"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** schema (Task 1), overlap exclusion (Task 3), MCP read/write parity (Tasks 6-7), web type (Task 2), chip (Tasks 4-5), agent gate (Task 9), briefing exposure (Tasks 6.5/7.5). All spec sections map to a task.
- **`owner_attends` semantics are consistent** everywhere: clash counts iff `subject_id == null || owner_attends`.
- **No FK on `subject_id`** is intentional (matches `assigned_to`); the pair constraint is the only DB-level guard. Subject-existence/scoping validation is deliberately deferred (agent resolves ids; a stale id just renders no chip) — note for a follow-up if bad ids become a problem.
- **Web reads need no query change** — `dbClient` events use `select('*')`, so columns arrive once Task 2 lands.
