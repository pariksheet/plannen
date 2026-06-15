# Overdue todos in the daily brief — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface incomplete past-dued todos (last 30 days) in the daily brief under a new `## Overdue` section above Schedule.

**Architecture:** Add one `overdue_todos` query to the existing `get_briefing_context` batch in both MCP runtimes (edge + Tier 0), then document the new `## Overdue` section in the day-plan skill. No schema change, no new tool.

**Tech Stack:** TypeScript, Deno (edge function), Node (Tier 0 MCP), Postgres (`plannen.events`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-overdue-todos-in-brief-design.md`

---

## File structure

- `supabase/functions/mcp/tools/briefings.ts` — edge `get_briefing_context`: add overdue query + `overdue_todos` in return. (Task 1, 2)
- `supabase/functions/mcp/tools/briefings.test.ts` — overdue inclusion/exclusion assertions; bump event-query count. (Task 1)
- `mcp/src/index.ts` — Tier 0 `getBriefingContext`: same query + return field. (Task 3)
- `plugin/skills/plannen-day-plan.md` — document the `## Overdue` section + format rule. (Task 4)

Tasks 1–2 are TDD on the edge implementation (the one Claude Code actually talks to). Task 3 mirrors it into Tier 0 (no separate unit test there — parity is by inspection against Task 2). Task 4 is docs.

---

### Task 1: Update edge tests for the overdue query (red)

**Files:**
- Test: `supabase/functions/mcp/tools/briefings.test.ts`

The existing test asserts exactly 3 `FROM plannen.events` queries. Adding the overdue query makes 4, and the new query must carry the cancelled filter and the open/window/kind predicates. Update the count and add a dedicated assertion for the overdue query's shape.

- [ ] **Step 1: Edit the existing event-count assertion and add the overdue-shape test**

In `supabase/functions/mcp/tools/briefings.test.ts`, change the `toHaveLength(3)` line inside the existing `'get_briefing_context excludes cancelled events from every events query'` test:

```typescript
    expect(eventQueries).toHaveLength(4) // today, tomorrow, recent past, overdue todos
```

Then add this new test immediately after that test's closing `})` (before the final `})` that closes the `describe`):

```typescript
  it('get_briefing_context queries overdue todos: open, not cancelled, todo-kind, 30d window', async () => {
    const queries: { sql: string; params: unknown[] }[] = []
    const ctx = {
      client: {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params })
          return { rows: [], rowCount: 0 }
        },
      } as any,
      userId: 'u1',
    }
    await briefingsModule.dispatch.get_briefing_context({ date: '2026-06-15' }, ctx)
    const overdue = queries.find(
      (q) => /FROM plannen\.events/i.test(q.sql) && /completed_at IS NULL/i.test(q.sql),
    )
    expect(overdue).toBeDefined()
    expect(overdue!.sql).toMatch(/event_kind\s*=\s*'todo'/i)
    expect(overdue!.sql).toMatch(/event_status\s*<>\s*'cancelled'/i)
    expect(overdue!.sql).toMatch(/INTERVAL\s*'30 days'/i)
    expect(overdue!.sql).toMatch(/INTERVAL\s*'1 day'/i)
    expect(overdue!.params).toEqual(['u1', '2026-06-15'])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/stroomnova/Music/plannen && npx vitest run supabase/functions/mcp/tools/briefings.test.ts`
Expected: FAIL — the count test fails (`expected 3 to be 4` → after edit, only 3 event queries exist so `expected 3 to have length 4`), and the new overdue test fails (`overdue` is `undefined`).

- [ ] **Step 3: Commit the red tests**

```bash
git add supabase/functions/mcp/tools/briefings.test.ts
git commit -m "test(brief): assert overdue-todos query in get_briefing_context"
```

---

### Task 2: Add the overdue query to the edge handler (green)

**Files:**
- Modify: `supabase/functions/mcp/tools/briefings.ts`

- [ ] **Step 1: Add `overdueRow` to the destructured `Promise.all`**

In `supabase/functions/mcp/tools/briefings.ts`, change the destructuring assignment (currently ends `...blackoutsRow, obligationsRow] =`) to add `overdueRow`:

```typescript
  const [userRow, circleRow, primaryCircleUsersRow, eventsTodayRow, eventsTomorrowRow, recentPastRow, practicesRow, completionsRow, locationsRow, attendancesRow, blackoutsRow, obligationsRow, overdueRow] =
    await Promise.all([
```

- [ ] **Step 2: Add the overdue query as the last element of the `Promise.all` array**

In the same file, the obligations query is the last element of the array — it ends with:

```typescript
        `SELECT o.id, o.user_id, o.derived_from_attendance_id, o.role, o.anchor,
                o.offset_minutes, o.location_id, o.active, a.family_member_id AS member_id
         FROM plannen.obligations o
         JOIN plannen.attendances a ON a.id = o.derived_from_attendance_id
         WHERE o.user_id = $1 AND o.active = true AND a.active = true`,
        [id],
      ),
    ])
```

Insert the new query between that closing `),` and the `])`, so the array now ends:

```typescript
        `SELECT o.id, o.user_id, o.derived_from_attendance_id, o.role, o.anchor,
                o.offset_minutes, o.location_id, o.active, a.family_member_id AS member_id
         FROM plannen.obligations o
         JOIN plannen.attendances a ON a.id = o.derived_from_attendance_id
         WHERE o.user_id = $1 AND o.active = true AND a.active = true`,
        [id],
      ),
      ctx.client.query(
        `SELECT id, title, start_date, location, event_kind
         FROM plannen.events
         WHERE created_by = $1
           AND event_kind = 'todo'
           AND completed_at IS NULL
           AND event_status <> 'cancelled'
           AND start_date::date BETWEEN ($2::date - INTERVAL '30 days')::date
                                    AND ($2::date - INTERVAL '1 day')::date
         ORDER BY start_date ASC`,
        [id, today],
      ),
    ])
```

- [ ] **Step 3: Expose `overdue_todos` in the return object**

In the same file, the return object currently ends:

```typescript
    locations: locationsRow.rows,
    attendances_today: attendancesToday,
    obligations_today: obligationsToday,
  }
}
```

Add `overdue_todos` after `obligations_today`:

```typescript
    locations: locationsRow.rows,
    attendances_today: attendancesToday,
    obligations_today: obligationsToday,
    overdue_todos: overdueRow.rows,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/stroomnova/Music/plannen && npx vitest run supabase/functions/mcp/tools/briefings.test.ts`
Expected: PASS — all tests green (count is now 4; overdue query matched with correct params).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/mcp/tools/briefings.ts
git commit -m "feat(brief): add overdue_todos to get_briefing_context (edge)"
```

---

### Task 3: Mirror the change into the Tier 0 handler

**Files:**
- Modify: `mcp/src/index.ts` (function `getBriefingContext`, around lines 2392–2551)

The Tier 0 handler is structurally identical to the edge one but uses `c.query(...)` (not `ctx.client.query`), `userId` (not `id`), and returns `{ id: userId }` fallback. Mirror the same three edits. There is no separate Tier 0 unit test; correctness here is by inspection against Task 2.

- [ ] **Step 1: Add `overdueRow` to the destructured `Promise.all`**

In `mcp/src/index.ts`, change the destructuring line (currently ends `...blackoutsRow, obligationsRow] =`) to:

```typescript
    const [userRow, circleRow, primaryCircleUsersRow, eventsTodayRow, eventsTomorrowRow, recentPastRow, practicesRow, completionsRow, locationsRow, attendancesRow, blackoutsRow, obligationsRow, overdueRow] =
      await Promise.all([
```

- [ ] **Step 2: Add the overdue query as the last element of the `Promise.all` array**

The obligations query (last element) ends:

```typescript
          `SELECT o.id, o.user_id, o.derived_from_attendance_id, o.role, o.anchor,
                  o.offset_minutes, o.location_id, o.active, a.family_member_id AS member_id
           FROM plannen.obligations o
           JOIN plannen.attendances a ON a.id = o.derived_from_attendance_id
           WHERE o.user_id = $1 AND o.active = true AND a.active = true`,
          [userId],
        ),
      ])
```

Insert the new query between that closing `),` and the `])`:

```typescript
          `SELECT o.id, o.user_id, o.derived_from_attendance_id, o.role, o.anchor,
                  o.offset_minutes, o.location_id, o.active, a.family_member_id AS member_id
           FROM plannen.obligations o
           JOIN plannen.attendances a ON a.id = o.derived_from_attendance_id
           WHERE o.user_id = $1 AND o.active = true AND a.active = true`,
          [userId],
        ),
        c.query(
          `SELECT id, title, start_date, location, event_kind
           FROM plannen.events
           WHERE created_by = $1
             AND event_kind = 'todo'
             AND completed_at IS NULL
             AND event_status <> 'cancelled'
             AND start_date::date BETWEEN ($2::date - INTERVAL '30 days')::date
                                      AND ($2::date - INTERVAL '1 day')::date
           ORDER BY start_date ASC`,
          [userId, today],
        ),
      ])
```

- [ ] **Step 3: Expose `overdue_todos` in the return object**

The return object ends:

```typescript
      locations: locationsRow.rows,
      attendances_today: attendancesToday,
      obligations_today: obligationsToday,
    }
  })
}
```

Add `overdue_todos`:

```typescript
      locations: locationsRow.rows,
      attendances_today: attendancesToday,
      obligations_today: obligationsToday,
      overdue_todos: overdueRow.rows,
    }
  })
}
```

- [ ] **Step 4: Verify both implementations build / typecheck**

Run: `cd /Users/stroomnova/Music/plannen && npm run check:parity`
Expected: PASS — MCP tool-name parity and engine parity both green (this change adds no new tool and touches no shared engine file, so parity is unaffected; this confirms nothing regressed).

Run: `cd /Users/stroomnova/Music/plannen && npx tsc -p mcp/tsconfig.json --noEmit`
Expected: PASS — no type errors in the Tier 0 server. (If `mcp/tsconfig.json` does not exist, run `cd /Users/stroomnova/Music/plannen/mcp && npx tsc --noEmit` instead.)

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts
git commit -m "feat(brief): add overdue_todos to get_briefing_context (Tier 0)"
```

---

### Task 4: Document the `## Overdue` section in the day-plan skill

**Files:**
- Modify: `plugin/skills/plannen-day-plan.md`

- [ ] **Step 1: Add `overdue_todos` to the context-tool description (Workflow step 2)**

In `plugin/skills/plannen-day-plan.md`, find the bullet list under step 2 that documents `attendances_today` and `obligations_today`. After the `obligations_today` bullet (the line starting `   - \`obligations_today\` —`), add:

```markdown
   - `overdue_todos` — open todos (`event_kind=todo`, not completed, not cancelled) whose due date fell in the last 30 days, oldest first. Render under a `## Overdue` section above Schedule.
```

- [ ] **Step 2: Add the `## Overdue` block to the markdown structure template**

In the same file, the structure template (the fenced ```markdown block in step 3) starts:

```markdown
   # <Weekday>, <D Mon>

   ## Schedule
```

Insert an Overdue section between the title and Schedule, so it reads:

```markdown
   # <Weekday>, <D Mon>

   ## Overdue
   - [ ] Todo title (due <D Mon>)        // overdue_todos, oldest first; omit section if none

   ## Schedule
```

- [ ] **Step 3: Add a format rule for the Overdue section**

In the same file, in the **Format rules:** bulleted list (step 3), add this bullet immediately after the "Conflict check first" bullet:

```markdown
   - **Overdue.** Render `overdue_todos` as `[ ]` checkbox lines under `## Overdue` above Schedule, oldest first, each annotated `(due <D Mon>)` from its `start_date`. Omit the whole section when `overdue_todos` is empty. On overflow it ranks just below time-conflicted events.
```

- [ ] **Step 4: Verify the skill file reads coherently**

Run: `cd /Users/stroomnova/Music/plannen && sed -n '14,47p' plugin/skills/plannen-day-plan.md`
Expected: the `overdue_todos` context bullet, the `## Overdue` block above `## Schedule`, and the new format rule are all present and well-formed.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/plannen-day-plan.md
git commit -m "docs(brief): document Overdue section in day-plan skill"
```

---

## Verification (after all tasks)

- [ ] `cd /Users/stroomnova/Music/plannen && npx vitest run supabase/functions/mcp/tools/briefings.test.ts` — all green.
- [ ] `cd /Users/stroomnova/Music/plannen && npm run check:parity` — green.
- [ ] Manual: run `/plannen-today` against a profile that has an open, past-dated todo within 30 days; confirm a `## Overdue` section appears above Schedule, and that completing the todo (`complete_todo`) removes it from the next brief.
