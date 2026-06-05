# Audit 07 — Build, Typecheck, Tests

## Summary
Typecheck and production build complete cleanly. The only build-time warning is a chunk-size warning on the single ~661 kB JS bundle (no code-splitting). Vitest runs 264 passing + 1 skipped tests, but **3 test files fail to even load** because `src/lib/supabase.ts` throws at import time when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are absent — and the test setup never injects them. This is the worst finding: any component or service test that transitively imports `src/lib/supabase.ts` aborts before a single assertion runs. There is no lint script. Playwright has one Tier-0 E2E spec (2 tests) which was inventoried only. Dev-server smoke could not be cleanly verified from this worktree because port 4321 is already held by a Vite process from the parent worktree (strictPort blocked our boot, as intended).

## Environment
- node: v24.15.0
- npm: 11.12.1
- worktree path: `/Users/stroomnova/Music/plannen/.worktrees/plannen-ui`
- deps: not freshly installed. `node_modules` was symlinked to the parent worktree (`ln -s ../../node_modules node_modules`). All commands resolved their binaries successfully against that link.

## Typecheck
- command: `npx tsc -b --noEmit`
- exit code: `0`
- error count: `0`
- errors: none — clean build with project references (`tsconfig.json` + `tsconfig.node.json`).

## Build
- command: `npm run build` (= `tsc -b && vite build`)
- exit code: `0`
- vite version: `6.4.2`
- modules transformed: `2003`
- build time: `1.08s`
- output:
  - `dist/index.html` — 1.63 kB (gzip 0.55 kB)
  - `dist/assets/index-Y3kINtcU.css` — 42.59 kB (gzip 7.84 kB)
  - `dist/assets/index-CJv9fHeS.js` — 661.16 kB (gzip 173.58 kB)
- total `dist/` on disk: **744 kB**
- warnings:
  ```
  (!) Some chunks are larger than 500 kB after minification. Consider:
  - Using dynamic import() to code-split the application
  - Use build.rollupOptions.output.manualChunks to improve chunking
  - Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
  ```
  No other warnings. The whole app ships as one chunk — no route-level or vendor-level code splitting is configured.

## Unit tests (vitest)
- command: `npm run test:run` (= `vitest run`)
- exit code: `1`
- runner: `vitest@4.1.5`, environment `jsdom`, setup `tests/setup.ts`
- duration: 1.57s (transform 849ms, setup 1.03s, import 1.96s, tests 204ms, environment 9.85s)
- totals: **Test Files 3 failed | 21 passed (24)** — **Tests 264 passed | 1 skipped (265)**

### Failed suites — all fail at module-load, zero tests executed in each

All three suites fail with the identical root error from `src/lib/supabase.ts:28` because `tests/setup.ts` does not stub `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, and `src/lib/dbClient.ts` → `src/lib/dbClient/tier1.ts` → `src/lib/supabase.ts` throws on import:

```
Error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.
Run `bash scripts/bootstrap.sh` to generate .env, or set them manually before `npm run dev`.
 ❯ src/lib/supabase.ts:28:9
 ❯ src/lib/dbClient/tier1.ts:6:1
 ❯ src/lib/dbClient.ts:7:1
```

- `tests/components/EventCard.test.tsx` — 0 tests run
- `tests/components/MyStories.test.tsx` — 0 tests run
- `tests/utils/memoryService.test.ts` — 0 tests run

`tests/setup.ts` only contains `import '@testing-library/jest-dom/vitest'` — there is no env stub or `vi.mock('@/lib/supabase', …)` baseline. The same failure will appear for any future test that pulls in services using the supabase client.

The other 21 suites pass (264 tests + 1 skipped), covering recurrence math, story languages, photo sampling, media-type mapping, event-source extraction, story subtitles, and 13 cloud/migration script tests under `tests/scripts/`.

## Lint
- present? **no**. `package.json` has no `lint` or `eslint` script. There is no `.eslintrc*` / `eslint.config.*` at the repo root either. Skipped.

## Playwright tests
- inventory only — `playwright.config.ts` points at `tests/e2e/`, baseURL `http://localhost:4321`, single chromium project, requires bootstrap + dev server running.
- specs:
  - `tests/e2e/tier0-smoke.spec.ts` — Tier-0 smoke: 2 tests
    - "Tier 0 — app loads with no login page, /api/me roundtrip works" — confirms `/api/me` is 200 with `userId`/`email`, no Sign-in/Magic-link UI
    - "Tier 0 — events list endpoint responds" — confirms `/api/events?limit=10` returns 200 with an array
- not run (per task instructions). Would also require `npx playwright install chromium` (~150 MB) plus pg + backend + dev server up.

Other non-vitest, non-playwright suites (also not run, listed for completeness):
- `tests/integration/migrate-tier0-to-tier1.test.sh` (shell)
- `tests/smoke/tier1-http-mcp.sh`, `tests/smoke/tier2-bootstrap.sh` (shell)

## Dev server smoke
- did it boot on :4321? **No, from this worktree.** The fresh `npm run dev` immediately exited with:
  ```
  error when starting dev server:
  Error: Port 4321 is already in use
  ```
  This is the documented `strictPort: true` failure mode in `vite.config.ts`. Port 4321 is held by a Vite process from the parent worktree (`PID 54146: node .../node_modules/.bin/vite`).
- because that pre-existing Vite is also serving the same `index.html`, the curl probe still returned data:
  - curl `http://localhost:4321/` → **HTTP 200**, **content-length 1801**, valid Vite-injected HTML (React refresh script, `/@vite/client`, `/src/main.tsx?t=…`, full `<head>` meta).
- caveat: that 200 is from the parent's dev server, not the worktree's. Booting the worktree's own dev server requires either stopping the parent's Vite or running on a different port (which the project intentionally forbids via strictPort).
- boot-time warnings/stderr: only the port-busy error above. No other noise during the short window observed.

Note: even with the port free, the dev server's runtime would still hit the same env-missing error path as the tests because `.env` does not exist in this worktree (`.env` and `.env.local` are absent). The HTML shell would render and then `src/lib/supabase.ts` would throw in the browser at first import.

## Top blockers for shipping

1. **Tests fail at import** — fix `tests/setup.ts` to stub `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (e.g. `vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')` + anon key in `beforeAll`), or mock `src/lib/supabase.ts` globally. As-is, the CI signal is broken: 3 suites silently skip every assertion, including the only `EventCard` and `MyStories` component coverage. This is a real regression risk for any UI work in this branch.
2. **No lint** — there's no `npm run lint` and no ESLint config. Style/quality regressions in the UI work won't be caught automatically. Adding `eslint` + `@typescript-eslint` + `eslint-plugin-react-hooks` would be the cheapest win.
3. **Single 661 kB JS chunk** — production bundle has zero code splitting. For a UI-heavy app this hurts first-paint on slow networks and triggers Vite's own warning. Add `build.rollupOptions.output.manualChunks` (vendor split for React, Supabase, lucide-react, date-fns) and/or `React.lazy` on route components.
4. **Worktree env hygiene** — neither `.env` nor `.env.local` exists in this worktree, and `node_modules` is a symlink to the parent. Tests work because env is read at runtime (and the failing suites would still fail with the parent's env, since `import.meta.env` is resolved per Vite project). For honest CI-style runs in a worktree, bootstrap or copy a `.env` first.
5. **Strict-port collision when multiple worktrees coexist** — expected and intended, but worth documenting: only one Plannen worktree can run `npm run dev` at a time. No code change needed; just a note for the audit follow-up.
6. **Playwright not actually exercised here** — the only E2E coverage (`tier0-smoke.spec.ts`) is small (2 tests) and was not run. Before shipping UI changes, run it against a clean tier-0 stack. Browser binary install (`npx playwright install chromium`) is a prerequisite that's easy to forget in CI.
