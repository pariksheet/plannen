// Vitest wrapper around tests/smoke/tier2-bootstrap.sh. Gated by env so the
// default CI run doesn't touch real cloud projects. Spend the budget only
// when you're explicitly testing Tier 2 changes:
//
//   RUN_TIER2_INTEGRATION=1 \
//   TIER2_TEST_PROJECT_REF=xxxxxxxxxxxxxxxxxxxx \
//   TIER2_TEST_CLOUD_DB_URL='postgresql://postgres.<ref>:<pw>@host:6543/postgres' \
//     npx vitest run tests/integration/tier2-bootstrap.test.ts
//
// The smoke script handles all assertions; this wrapper just shells out
// and surfaces success/failure via vitest. Tests skip cleanly when the env
// vars aren't set.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SMOKE = join(REPO_ROOT, 'tests', 'smoke', 'tier2-bootstrap.sh')

const SHOULD_RUN =
  process.env.RUN_TIER2_INTEGRATION === '1' &&
  !!process.env.TIER2_TEST_PROJECT_REF &&
  !!process.env.TIER2_TEST_CLOUD_DB_URL

describe.skipIf(!SHOULD_RUN)('tier 2 bootstrap (integration)', () => {
  it('round-trips Tier 1 → Tier 2 → Tier 1 with row/photo parity', () => {
    const r = spawnSync('bash', [SMOKE], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    })
    expect(r.status).toBe(0)
  }, 600_000)
})

// Lightweight assertion when the integration tier is skipped: keep a single
// passing test so the file isn't 'empty' to vitest's reporter.
describe.skipIf(SHOULD_RUN)('tier 2 bootstrap (skipped)', () => {
  it('runs only when RUN_TIER2_INTEGRATION=1 with project + cloud db env', () => {
    expect(SHOULD_RUN).toBe(false)
  })
})
