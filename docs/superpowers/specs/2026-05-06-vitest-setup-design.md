# Vitest Setup — Design Spec

**Date:** 2026-05-06
**Status:** Approved

## Overview

Add Vitest as the project's test framework. Covers unit tests for pure logic (utils, services) and component tests via React Testing Library. Tests live in a top-level `tests/` directory mirroring `src/`. Coverage via V8 provider.

## Packages

All added as devDependencies:

| Package | Purpose |
|---|---|
| `vitest` | Test runner |
| `@vitest/coverage-v8` | V8 coverage provider |
| `jsdom` | DOM environment for component tests |
| `@testing-library/react` | Component rendering and querying |
| `@testing-library/jest-dom` | Extra matchers (`toBeInTheDocument`, etc.) |
| `@testing-library/user-event` | Realistic user interaction simulation |

## Config

### `vitest.config.ts` (new, project root)

Extends the existing `vite.config.ts` via `mergeConfig` so the React plugin and any future Vite config is shared without duplication.

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

### `tests/setup.ts` (new)

```ts
import '@testing-library/jest-dom'
```

### `package.json` scripts

```json
"test":          "vitest",
"test:run":      "vitest run",
"test:coverage": "vitest run --coverage"
```

### `tsconfig.json`

Change `include` from `["src"]` to `["src", "tests"]` so TypeScript resolves the setup file and test utility types.

## Directory Structure

```
tests/
├── setup.ts
├── utils/
│   └── recurrence.test.ts      # first test — pure logic, no mocks needed
├── services/
│   └── (service tests — mock src/lib/supabase via vi.mock())
└── components/
    └── (RTL component tests)
```

## Supabase Mocking

Services import the Supabase client from `src/lib/supabase`. Tests mock this module using `vi.mock('../../src/lib/supabase')` so no real database calls happen in tests.

## npm Scripts

| Command | Behaviour |
|---|---|
| `npm test` | Watch mode — re-runs affected tests on file change |
| `npm run test:run` | Single run — for CI |
| `npm run test:coverage` | Single run with V8 coverage report |

## Out of Scope

- End-to-end tests (Playwright, Cypress)
- Snapshot testing
- MSW for network mocking (add later if needed)
