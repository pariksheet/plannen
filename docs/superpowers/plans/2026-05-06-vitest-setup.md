# Vitest Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up Vitest with React Testing Library and V8 coverage so the project has a working test suite from day one.

**Architecture:** Separate `vitest.config.ts` extends the existing `vite.config.ts` via `mergeConfig` — no duplication of the React plugin. Tests live in a top-level `tests/` directory mirroring `src/`. A `tests/setup.ts` bootstraps `@testing-library/jest-dom` matchers globally.

**Tech Stack:** Vitest 2.x, @testing-library/react, @testing-library/jest-dom, @testing-library/user-event, jsdom, @vitest/coverage-v8

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `vitest.config.ts` | Test runner config (env, setup, coverage) |
| Create | `tests/setup.ts` | Import jest-dom matchers once, globally |
| Create | `tests/utils/recurrence.test.ts` | First real tests — pure logic, no mocks |
| Modify | `tsconfig.json` | Add `"tests"` to `include` |
| Modify | `package.json` | Add `test`, `test:run`, `test:coverage` scripts |

---

## Task 1: Install packages

**Files:** `package.json`

- [ ] **Step 1: Install dev dependencies**

```bash
npm install -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Expected: all packages listed under `devDependencies` in `package.json`.

- [ ] **Step 2: Verify install**

```bash
npx vitest --version
```

Expected output: a version string like `2.x.x`.

---

## Task 2: Create `vitest.config.ts`

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Create the file**

`vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['text', 'html'],
    },
  },
}))
```

- [ ] **Step 2: Check TypeScript accepts the file**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 3: Create `tests/setup.ts` and update `tsconfig.json`

**Files:**
- Create: `tests/setup.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Create setup file**

`tests/setup.ts`:
```ts
import '@testing-library/jest-dom'
```

- [ ] **Step 2: Update `tsconfig.json`**

Change:
```json
"include": ["src"]
```
To:
```json
"include": ["src", "tests"]
```

- [ ] **Step 3: Verify TypeScript still passes**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 4: Add npm scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts to `package.json`**

In the `"scripts"` block, add:
```json
"test":          "vitest",
"test:run":      "vitest run",
"test:coverage": "vitest run --coverage"
```

The full scripts block should look like:
```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "test": "vitest",
  "test:run": "vitest run",
  "test:coverage": "vitest run --coverage"
}
```

- [ ] **Step 2: Smoke-test with no test files**

```bash
npm run test:run
```

Expected: exits with a message like `No test files found` or `0 tests passed`. It must NOT crash or throw a config error.

- [ ] **Step 3: Commit the setup**

```bash
git add vitest.config.ts tests/setup.ts tsconfig.json package.json package-lock.json
git commit -m "feat: add Vitest with RTL and V8 coverage"
```

---

## Task 5: Write first tests — `recurrence.ts`

`src/utils/recurrence.ts` exports `generateSessionDates(parentStartDate, rule)` which returns `{ start: Date; end: Date | null }[]`. It supports `daily`, `weekly`, and `monthly` frequencies, controlled by `count` or `until`.

**Files:**
- Create: `tests/utils/recurrence.test.ts`

- [ ] **Step 1: Create the test file**

`tests/utils/recurrence.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { generateSessionDates } from '../../src/utils/recurrence'

const ONE_DAY_MS   = 24 * 60 * 60 * 1_000
const ONE_WEEK_MS  = 7 * ONE_DAY_MS
const ONE_MONTH_MS = 30 * ONE_DAY_MS // approximate — only used for loose bounds checks

describe('generateSessionDates', () => {
  describe('daily', () => {
    it('returns the correct count', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 3,
      })
      expect(results).toHaveLength(3)
    })

    it('spaces sessions exactly one day apart', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 3,
      })
      expect(results[1].start.getTime() - results[0].start.getTime()).toBe(ONE_DAY_MS)
      expect(results[2].start.getTime() - results[1].start.getTime()).toBe(ONE_DAY_MS)
    })

    it('respects interval', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        interval: 2,
        count: 3,
      })
      expect(results[1].start.getTime() - results[0].start.getTime()).toBe(2 * ONE_DAY_MS)
      expect(results[2].start.getTime() - results[1].start.getTime()).toBe(2 * ONE_DAY_MS)
    })

    it('stops on or before until date', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        until: '2026-01-03T23:59:59Z',
      })
      expect(results).toHaveLength(3) // Jan 1, 2, 3
      expect(results.every(r => r.start <= new Date('2026-01-03T23:59:59Z'))).toBe(true)
    })

    it('returns empty array when neither count nor until is given', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
      })
      expect(results).toHaveLength(0)
    })

    it('attaches correct end date when session_duration_minutes is set', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 1,
        session_duration_minutes: 90,
      })
      expect(results[0].end).not.toBeNull()
      const durationMs = results[0].end!.getTime() - results[0].start.getTime()
      expect(durationMs).toBe(90 * 60_000)
    })

    it('sets end to null when session_duration_minutes is not set', () => {
      const results = generateSessionDates('2026-01-01T00:00:00Z', {
        frequency: 'daily',
        count: 1,
      })
      expect(results[0].end).toBeNull()
    })
  })

  describe('weekly', () => {
    it('generates sessions only on the specified days', () => {
      // Start on Monday 2026-01-05; request MO + WE for 4 sessions
      const results = generateSessionDates('2026-01-05T00:00:00Z', {
        frequency: 'weekly',
        days: ['MO', 'WE'],
        count: 4,
      })
      expect(results).toHaveLength(4)
      // All results must be a Monday (1) or Wednesday (3)
      results.forEach(r => {
        expect([1, 3]).toContain(r.start.getDay())
      })
    })

    it('produces sessions in chronological order', () => {
      const results = generateSessionDates('2026-01-05T00:00:00Z', {
        frequency: 'weekly',
        days: ['MO', 'WE', 'FR'],
        count: 6,
      })
      for (let i = 1; i < results.length; i++) {
        expect(results[i].start.getTime()).toBeGreaterThan(results[i - 1].start.getTime())
      }
    })

    it('advances by interval weeks between same-day sessions', () => {
      const results = generateSessionDates('2026-01-05T00:00:00Z', {
        frequency: 'weekly',
        days: ['MO'],
        interval: 2,
        count: 3,
      })
      expect(results).toHaveLength(3)
      expect(results[1].start.getTime() - results[0].start.getTime()).toBe(2 * ONE_WEEK_MS)
      expect(results[2].start.getTime() - results[1].start.getTime()).toBe(2 * ONE_WEEK_MS)
    })
  })

  describe('monthly', () => {
    it('returns the correct count', () => {
      const results = generateSessionDates('2026-01-15T00:00:00Z', {
        frequency: 'monthly',
        count: 4,
      })
      expect(results).toHaveLength(4)
    })

    it('advances by one calendar month each session', () => {
      const results = generateSessionDates('2026-01-15T00:00:00Z', {
        frequency: 'monthly',
        count: 3,
      })
      // Each gap should be roughly a month (28–31 days)
      for (let i = 1; i < results.length; i++) {
        const gapDays = (results[i].start.getTime() - results[i - 1].start.getTime()) / ONE_DAY_MS
        expect(gapDays).toBeGreaterThanOrEqual(28)
        expect(gapDays).toBeLessThanOrEqual(31)
      }
    })
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npm run test:run
```

Expected output:
```
✓ tests/utils/recurrence.test.ts (13)
Test Files  1 passed (1)
Tests       13 passed (13)
```

All 13 tests should pass immediately — the implementation already exists.

- [ ] **Step 3: Run coverage**

```bash
npm run test:coverage
```

Expected: coverage table printed to terminal, `coverage/` directory created with HTML report. `src/utils/recurrence.ts` should show high line coverage (80%+).

- [ ] **Step 4: Commit**

```bash
git add tests/utils/recurrence.test.ts
git commit -m "test: add recurrence unit tests"
```
