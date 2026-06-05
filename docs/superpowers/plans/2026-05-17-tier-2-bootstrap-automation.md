# Tier 2 Bootstrap Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the Tier 2 cloud-deploy flow from ~10 manual steps to ~2 (pick project + paste DB password), by using the Supabase Management API for dashboard-only operations and folding the Vercel deploy into the bootstrap flow.

**Architecture:** New `scripts/lib/supabase-mgmt.mjs` wraps the Supabase Management API (`https://api.supabase.com/v1`), authenticating via the access token that `supabase login` already writes to `~/.supabase/access-token`. New interactive picker (`scripts/lib/cloud-project-picker.mjs`) replaces the `--project-ref` flag. The migration orchestrator (`scripts/lib/migrate-tier1-to-tier2.mjs`) gains two new idempotent steps — `expose-schemas` and `wire-auth` — that call the new helper. `scripts/bootstrap.sh` learns to offer a Vercel deploy at the end, and `scripts/lib/vercel-deploy.mjs` learns to non-interactively link the project and update Supabase Auth URLs after deploy succeeds. All new logic ships behind dependency-injected `fetch` so it's fully unit-testable without network.

**Tech Stack:** Node 20 ESM, vitest, bash, Supabase Management API, Vercel CLI.

**Spec:** [`docs/superpowers/specs/2026-05-17-tier-2-bootstrap-automation-design.md`](../specs/2026-05-17-tier-2-bootstrap-automation-design.md)

---

## Task 1: Supabase Management API client

**Files:**
- Create: `scripts/lib/supabase-mgmt.mjs`
- Test: `tests/scripts/supabase-mgmt.test.ts`

This module is the foundation — every later task uses it. Five functions, each tested in isolation. All HTTP calls go through an injected `fetch` so the tests need no real network.

- [ ] **Step 1.1: Write the test for `readAccessToken`**

Create `tests/scripts/supabase-mgmt.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import {
  readAccessToken,
  listProjects,
  getAuthConfig,
  setExposedSchemas,
  updateAuthConfig,
  mergeAllowList,
} from '../../scripts/lib/supabase-mgmt.mjs'

describe('readAccessToken', () => {
  it('prefers SUPABASE_ACCESS_TOKEN env var', () => {
    const t = readAccessToken({
      env: { SUPABASE_ACCESS_TOKEN: 'env-token' },
      readFile: () => 'file-token\n',
    })
    expect(t).toBe('env-token')
  })

  it('falls back to ~/.supabase/access-token when env unset', () => {
    const t = readAccessToken({
      env: {},
      readFile: () => '  file-token\n',
    })
    expect(t).toBe('file-token')
  })

  it('returns null when neither source is available', () => {
    const t = readAccessToken({
      env: {},
      readFile: () => { throw new Error('ENOENT') },
    })
    expect(t).toBeNull()
  })
})
```

- [ ] **Step 1.2: Run it to make sure it fails**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 1.3: Implement `readAccessToken` minimally**

Create `scripts/lib/supabase-mgmt.mjs`:

```javascript
// Supabase Management API client. Authenticates via the personal access
// token that `supabase login` writes to ~/.supabase/access-token, or
// SUPABASE_ACCESS_TOKEN if set. All HTTP is dep-injected so the test
// harness drives the full module without network.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API_BASE = 'https://api.supabase.com/v1'
const DEFAULT_TOKEN_PATH = join(homedir(), '.supabase', 'access-token')

// Pure: token discovery. env first, then file. Returns null if neither.
export function readAccessToken({ env = process.env, readFile = defaultReadFile, path = DEFAULT_TOKEN_PATH } = {}) {
  const fromEnv = env.SUPABASE_ACCESS_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const t = readFile(path)
    if (t && t.trim()) return t.trim()
  } catch {
    /* file missing → fall through */
  }
  return null
}

function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}
```

- [ ] **Step 1.4: Run the test — should pass**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts -t readAccessToken
```

Expected: PASS.

- [ ] **Step 1.5: Write tests for `listProjects`**

Append to the test file:

```typescript
describe('listProjects', () => {
  it('GETs /v1/projects with Bearer auth and returns the parsed list', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 'a', ref: 'aaaa1111', name: 'one', region: 'eu-central-1' },
          { id: 'b', ref: 'bbbb2222', name: 'two', region: 'us-east-1' },
        ],
      }
    }
    const projects = await listProjects('tok', { fetch: fakeFetch as any })
    expect(projects).toHaveLength(2)
    expect(projects[0].ref).toBe('aaaa1111')
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
  })

  it('throws a clean 401 message when token is expired', async () => {
    const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
    await expect(listProjects('bad', { fetch: fakeFetch as any })).rejects.toThrow(/supabase access token (rejected|expired)/i)
  })
})
```

- [ ] **Step 1.6: Run — should fail**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts -t listProjects
```

Expected: FAIL — `listProjects` not exported.

- [ ] **Step 1.7: Implement `listProjects` + a shared HTTP helper**

Append to `scripts/lib/supabase-mgmt.mjs`:

```javascript
// IO: shared HTTP wrapper. Throws a clean message on 401 so the caller
// can suggest `supabase login` rather than dumping the raw response.
async function request({ method, path, body, token, fetch = globalThis.fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) {
    throw new Error('supabase access token rejected (run `supabase login` to refresh)')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`supabase-mgmt ${method} ${path} → HTTP ${res.status}: ${text}`)
  }
  return res
}

// IO: list all projects the access token can see.
export async function listProjects(token, { fetch = globalThis.fetch } = {}) {
  const res = await request({ method: 'GET', path: '/projects', token, fetch })
  return res.json()
}
```

- [ ] **Step 1.8: Run — should pass**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts -t listProjects
```

Expected: PASS.

- [ ] **Step 1.9: Write tests for `mergeAllowList`**

Append:

```typescript
describe('mergeAllowList', () => {
  it('unions existing entries with new ones, deduped', () => {
    const merged = mergeAllowList(['http://localhost:4321/**'], ['https://plannen.vercel.app/**'])
    expect(merged).toEqual(['http://localhost:4321/**', 'https://plannen.vercel.app/**'])
  })

  it('does not duplicate an entry already present', () => {
    const merged = mergeAllowList(['https://a/**'], ['https://a/**', 'https://b/**'])
    expect(merged).toEqual(['https://a/**', 'https://b/**'])
  })

  it('handles null/undefined current list', () => {
    const merged = mergeAllowList(undefined, ['https://a/**'])
    expect(merged).toEqual(['https://a/**'])
  })
})
```

- [ ] **Step 1.10: Run — should fail**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts -t mergeAllowList
```

Expected: FAIL.

- [ ] **Step 1.11: Implement `mergeAllowList`**

Append to `scripts/lib/supabase-mgmt.mjs`:

```javascript
// Pure: dedupe-union of two allow-list arrays. Preserves order: current
// entries first (in their existing order), new entries appended.
export function mergeAllowList(current, additions) {
  const seen = new Set()
  const out = []
  for (const e of current ?? []) {
    if (!seen.has(e)) { seen.add(e); out.push(e) }
  }
  for (const e of additions ?? []) {
    if (!seen.has(e)) { seen.add(e); out.push(e) }
  }
  return out
}
```

- [ ] **Step 1.12: Run — should pass**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts -t mergeAllowList
```

Expected: PASS.

- [ ] **Step 1.13: Write tests for `getAuthConfig` + `updateAuthConfig` + `setExposedSchemas`**

Append:

```typescript
describe('getAuthConfig', () => {
  it('GETs /v1/projects/<ref>/config/auth', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:3000', uri_allow_list: '' }) }
    }
    const cfg = await getAuthConfig('tok', 'abcd1234', { fetch: fakeFetch as any })
    expect(cfg.site_url).toBe('http://localhost:3000')
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abcd1234/config/auth')
  })
})

describe('updateAuthConfig', () => {
  it('fetches current allow-list then PATCHes a union', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:3000', uri_allow_list: 'http://localhost:4321/**' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await updateAuthConfig('tok', 'abcd1234', {
      siteUrl: 'https://plannen.vercel.app',
      addAllowList: ['https://plannen.vercel.app/**'],
    }, { fetch: fakeFetch as any })

    expect(calls).toHaveLength(2)
    expect(calls[1].init.method).toBe('PATCH')
    const body = JSON.parse(calls[1].init.body)
    expect(body.site_url).toBe('https://plannen.vercel.app')
    // Allow-list serialized as comma-separated string.
    expect(body.uri_allow_list.split(',').sort()).toEqual([
      'http://localhost:4321/**',
      'https://plannen.vercel.app/**',
    ])
  })

  it('skips PATCH when there is nothing to change', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      if (init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ site_url: 'https://plannen.vercel.app', uri_allow_list: 'https://plannen.vercel.app/**' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await updateAuthConfig('tok', 'abcd1234', {
      siteUrl: 'https://plannen.vercel.app',
      addAllowList: ['https://plannen.vercel.app/**'],
    }, { fetch: fakeFetch as any })
    expect(calls).toHaveLength(1)  // only the GET, no PATCH
  })
})

describe('setExposedSchemas', () => {
  it('PATCHes /v1/projects/<ref>/postgrest with the joined schema list', async () => {
    const calls: any[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await setExposedSchemas('tok', 'abcd1234', ['plannen', 'public', 'graphql_public'], { fetch: fakeFetch as any })
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abcd1234/postgrest')
    expect(calls[0].init.method).toBe('PATCH')
    const body = JSON.parse(calls[0].init.body)
    expect(body.db_schema).toBe('plannen,public,graphql_public')
  })
})
```

- [ ] **Step 1.14: Run — should fail**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts
```

Expected: 3 of the new tests fail (functions not exported).

- [ ] **Step 1.15: Implement the three remaining functions**

Append to `scripts/lib/supabase-mgmt.mjs`:

```javascript
// IO: read the current Auth config for a project.
export async function getAuthConfig(token, ref, { fetch = globalThis.fetch } = {}) {
  const res = await request({ method: 'GET', path: `/projects/${ref}/config/auth`, token, fetch })
  return res.json()
}

// IO: patch Auth config. Caller passes the desired siteUrl and additions
// to the allow-list; we GET the current list and PATCH the union back so
// we never clobber entries the user added by hand. If the resulting
// payload would be a no-op, we skip the PATCH.
//
// patch = { siteUrl?: string, addAllowList?: string[] }
export async function updateAuthConfig(token, ref, patch, { fetch = globalThis.fetch } = {}) {
  const current = await getAuthConfig(token, ref, { fetch })
  const currentList = (current.uri_allow_list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const nextList = mergeAllowList(currentList, patch.addAllowList ?? [])
  const body = {}
  if (patch.siteUrl && patch.siteUrl !== current.site_url) {
    body.site_url = patch.siteUrl
  }
  if (nextList.length !== currentList.length || nextList.some((e, i) => e !== currentList[i])) {
    body.uri_allow_list = nextList.join(',')
  }
  if (Object.keys(body).length === 0) return { changed: false }
  await request({ method: 'PATCH', path: `/projects/${ref}/config/auth`, body, token, fetch })
  return { changed: true, body }
}

// IO: set the PostgREST exposed schemas. The Management API accepts a
// comma-separated `db_schema` string. Idempotent — PATCHing the same
// value is a no-op server-side.
export async function setExposedSchemas(token, ref, schemas, { fetch = globalThis.fetch } = {}) {
  const body = { db_schema: schemas.join(',') }
  await request({ method: 'PATCH', path: `/projects/${ref}/postgrest`, body, token, fetch })
  return { schemas }
}
```

- [ ] **Step 1.16: Run all the new tests — should pass**

```bash
npx vitest run tests/scripts/supabase-mgmt.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 1.17: Commit**

```bash
git add scripts/lib/supabase-mgmt.mjs tests/scripts/supabase-mgmt.test.ts
git commit -m "feat(tier-2/B.2.1): supabase management API client (lib + tests)"
```

---

## Task 2: Pooler URL builder

**Files:**
- Create: `scripts/lib/cloud-db-url.mjs`
- Test: `tests/scripts/cloud-db-url.test.ts`

Tiny pure module. Builds the canonical Supabase pooler URL from `{projectRef, region, password}` so the user only has to paste the password.

- [ ] **Step 2.1: Write the test**

Create `tests/scripts/cloud-db-url.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import { buildPoolerUrl } from '../../scripts/lib/cloud-db-url.mjs'

describe('buildPoolerUrl', () => {
  it('formats the standard pooler URL for eu-central-1', () => {
    const u = buildPoolerUrl({ projectRef: 'abcd1234', region: 'eu-central-1', password: 'hunter2' })
    expect(u).toBe('postgresql://postgres.abcd1234:hunter2@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')
  })

  it('percent-encodes special characters in the password', () => {
    const u = buildPoolerUrl({ projectRef: 'ref', region: 'us-east-1', password: 'p@ss:w/d#' })
    expect(u).toContain('postgres.ref:p%40ss%3Aw%2Fd%23@')
  })

  it('throws on missing fields', () => {
    expect(() => buildPoolerUrl({ projectRef: '', region: 'eu-central-1', password: 'x' })).toThrow(/projectRef/)
    expect(() => buildPoolerUrl({ projectRef: 'r', region: '', password: 'x' })).toThrow(/region/)
    expect(() => buildPoolerUrl({ projectRef: 'r', region: 'eu-central-1', password: '' })).toThrow(/password/)
  })
})
```

- [ ] **Step 2.2: Run — should fail**

```bash
npx vitest run tests/scripts/cloud-db-url.test.ts
```

Expected: FAIL.

- [ ] **Step 2.3: Implement**

Create `scripts/lib/cloud-db-url.mjs`:

```javascript
// Pure: canonical Supabase Cloud connection-pooler URL.
//
// Template (as documented in supabase.com/dashboard):
//   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
//
// We percent-encode the password to survive special characters; ref and
// region are constrained by Supabase to URL-safe charsets already.

export function buildPoolerUrl({ projectRef, region, password }) {
  if (!projectRef) throw new Error('buildPoolerUrl: projectRef is required')
  if (!region) throw new Error('buildPoolerUrl: region is required')
  if (!password) throw new Error('buildPoolerUrl: password is required')
  const pw = encodeURIComponent(password)
  return `postgresql://postgres.${projectRef}:${pw}@aws-0-${region}.pooler.supabase.com:6543/postgres`
}
```

- [ ] **Step 2.4: Run — should pass**

```bash
npx vitest run tests/scripts/cloud-db-url.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/lib/cloud-db-url.mjs tests/scripts/cloud-db-url.test.ts
git commit -m "feat(tier-2/B.2.1): pooler URL builder"
```

---

## Task 3: Interactive project picker

**Files:**
- Create: `scripts/lib/cloud-project-picker.mjs`
- Test: `tests/scripts/cloud-project-picker.test.ts`

Renders a numbered menu of projects, reads a selection from stdin, returns the chosen `{ ref, region }`. All I/O dep-injected.

- [ ] **Step 3.1: Write the tests for pure helpers**

Create `tests/scripts/cloud-project-picker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import { formatProjectMenu, parseSelection, pick } from '../../scripts/lib/cloud-project-picker.mjs'

const SAMPLE = [
  { id: 'a', ref: 'aaaa1111aaaa1111aaaa', name: 'plannen', region: 'eu-central-1' },
  { id: 'b', ref: 'bbbb2222bbbb2222bbbb', name: 'other', region: 'us-east-1' },
]

describe('formatProjectMenu', () => {
  it('renders a numbered list with name, ref, region', () => {
    const out = formatProjectMenu(SAMPLE)
    expect(out).toContain('1) plannen (aaaa1111aaaa1111aaaa, eu-central-1)')
    expect(out).toContain('2) other (bbbb2222bbbb2222bbbb, us-east-1)')
  })

  it('handles an empty list', () => {
    expect(formatProjectMenu([])).toMatch(/no projects/i)
  })
})

describe('parseSelection', () => {
  it('returns the project for a valid 1-based index', () => {
    const p = parseSelection('2', SAMPLE)
    expect(p.ref).toBe('bbbb2222bbbb2222bbbb')
  })

  it('trims whitespace', () => {
    expect(parseSelection('  1\n', SAMPLE).name).toBe('plannen')
  })

  it('throws on out-of-range', () => {
    expect(() => parseSelection('3', SAMPLE)).toThrow(/out of range/i)
    expect(() => parseSelection('0', SAMPLE)).toThrow(/out of range/i)
  })

  it('throws on non-numeric', () => {
    expect(() => parseSelection('hello', SAMPLE)).toThrow(/numeric/i)
  })
})

describe('pick', () => {
  it('writes the menu then resolves the selected project', async () => {
    const written: string[] = []
    const p = await pick(SAMPLE, {
      write: (s: string) => { written.push(s) },
      read: async () => '1\n',
    })
    expect(p.name).toBe('plannen')
    expect(written.join('')).toContain('1) plannen')
  })

  it('re-prompts on invalid input until a valid choice is given', async () => {
    const reads = ['bogus\n', '99\n', '2\n']
    const p = await pick(SAMPLE, {
      write: () => {},
      read: async () => reads.shift()!,
    })
    expect(p.name).toBe('other')
  })
})
```

- [ ] **Step 3.2: Run — should fail**

```bash
npx vitest run tests/scripts/cloud-project-picker.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3.3: Implement the picker**

Create `scripts/lib/cloud-project-picker.mjs`:

```javascript
// Interactive picker for Supabase Cloud projects. Pure helpers for
// formatting + parsing; dep-injected read/write for the loop.

// Pure: render the menu.
export function formatProjectMenu(projects) {
  if (projects.length === 0) return 'no projects found on this account.\n'
  const lines = projects.map((p, i) => `  ${i + 1}) ${p.name} (${p.ref}, ${p.region})`)
  return `Select a Supabase project:\n${lines.join('\n')}\n`
}

// Pure: parse a "1"-style selection. Throws on invalid input.
export function parseSelection(input, projects) {
  const trimmed = String(input).trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`selection must be numeric, got: "${trimmed}"`)
  }
  const idx = Number(trimmed) - 1
  if (idx < 0 || idx >= projects.length) {
    throw new Error(`selection out of range: ${trimmed} (1..${projects.length})`)
  }
  return projects[idx]
}

// IO: render menu, read a selection, re-prompt on invalid input.
//
// deps = { read: () => Promise<string>, write: (s: string) => void }
export async function pick(projects, deps) {
  if (projects.length === 0) {
    throw new Error('no projects found on this Supabase account')
  }
  deps.write(formatProjectMenu(projects))
  // First attempt + retry loop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    deps.write('  > ')
    const input = await deps.read()
    try {
      return parseSelection(input, projects)
    } catch (e) {
      deps.write(`  ${(e instanceof Error ? e.message : String(e))}\n`)
    }
  }
}
```

- [ ] **Step 3.4: Run — should pass**

```bash
npx vitest run tests/scripts/cloud-project-picker.test.ts
```

Expected: PASS.

- [ ] **Step 3.5: Add a CLI entrypoint so bootstrap.sh can shell out**

Append to `scripts/lib/cloud-project-picker.mjs`:

```javascript
// CLI entry. Used by bootstrap.sh:
//   node scripts/lib/cloud-project-picker.mjs
// Reads SUPABASE_ACCESS_TOKEN from env (or ~/.supabase/access-token),
// lists projects, prompts on /dev/tty (so the menu survives subshells +
// pipes), prints the picked ref + region to stdout as JSON for the
// shell to consume:
//   {"ref":"<ref>","region":"<region>","name":"<name>"}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createInterface } = await import('node:readline')
  const { openSync, createReadStream, createWriteStream } = await import('node:fs')
  const { readAccessToken, listProjects } = await import('./supabase-mgmt.mjs')
  try {
    const token = readAccessToken()
    if (!token) {
      process.stderr.write('no Supabase access token — run `supabase login` first\n')
      process.exit(2)
    }
    const projects = await listProjects(token)
    // Prompt against /dev/tty so the JSON on stdout stays clean.
    const ttyIn = createReadStream('/dev/tty')
    const ttyOut = createWriteStream('/dev/tty')
    const rl = createInterface({ input: ttyIn, output: ttyOut, terminal: false })
    const read = () => new Promise((resolve) => rl.once('line', resolve))
    const write = (s) => ttyOut.write(s)
    const chosen = await pick(projects, { read, write })
    rl.close()
    ttyIn.close()
    ttyOut.end()
    process.stdout.write(JSON.stringify({ ref: chosen.ref, region: chosen.region, name: chosen.name }) + '\n')
  } catch (e) {
    process.stderr.write(`cloud-project-picker: ${e.message}\n`)
    process.exit(1)
  }
}
```

- [ ] **Step 3.6: Make it executable**

```bash
chmod +x scripts/lib/cloud-project-picker.mjs
```

- [ ] **Step 3.7: Commit**

```bash
git add scripts/lib/cloud-project-picker.mjs tests/scripts/cloud-project-picker.test.ts
git commit -m "feat(tier-2/B.2.1): interactive cloud project picker"
```

---

## Task 4: Add `expose-schemas` step to the migration orchestrator

**Files:**
- Modify: `scripts/lib/migrate-tier1-to-tier2.mjs`
- Modify: `tests/scripts/migrate-tier1-to-tier2.test.ts`

The orchestrator's STEPS array currently has 8 entries. We insert `'expose-schemas'` after `'push-schema'` and before `'restore-data'`. The new step calls `supabase-mgmt.setExposedSchemas(...)`. If no access token is available, log a skip note and continue — the dashboard path still works.

- [ ] **Step 4.1: Update the STEPS-order assertion test**

In `tests/scripts/migrate-tier1-to-tier2.test.ts`, find the test `lists 8 named steps in spec order` and replace its body:

```typescript
  it('lists 9 named steps in spec order', () => {
    expect(STEPS).toEqual([
      'snapshot',
      'link',
      'push-schema',
      'expose-schemas',
      'restore-data',
      'upload-photos',
      'deploy',
      'rewrite-config',
      'verify',
    ])
  })
```

Also update the other `STEPS` assertion in the same file (search for the `'verify'` literal — there's a second list in the end-to-end test ctx).

- [ ] **Step 4.2: Add a focused test for the new step**

Append a new `describe` block in `tests/scripts/migrate-tier1-to-tier2.test.ts`:

```typescript
describe('stepExposeSchemas (via run)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plannen-expose-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('calls setExposedSchemas with [plannen,public,graphql_public]', async () => {
    const calls: any[] = []
    const deps = {
      log: () => {},
      // Stub every other step so we can isolate expose-schemas.
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ tools: [{ name: 'x' }] }) }),
      supabaseMgmt: {
        setExposedSchemas: async (token: string, ref: string, schemas: string[]) => {
          calls.push({ token, ref, schemas })
        },
        updateAuthConfig: async () => ({ changed: false }),
        readAccessToken: () => 'tok',
      },
    }
    // Pre-populate progress so we only run expose-schemas.
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nrestore-data\nupload-photos\ndeploy\nrewrite-config\nverify\n')
    // Now reset to test just expose-schemas + downstream skipping.
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\n')
    // Provide enough ctx to skip later steps' preconditions.
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(calls).toHaveLength(1)
    expect(calls[0].schemas).toEqual(['plannen', 'public', 'graphql_public'])
    expect(calls[0].ref).toBe('abcd1234abcd1234abcd')
  })

  it('skips with a log line when no access token is available', async () => {
    const logs: string[] = []
    const deps = {
      log: (s: string) => { logs.push(s) },
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ tools: [{ name: 'x' }] }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => { throw new Error('should not be called') },
        updateAuthConfig: async () => ({ changed: false }),
        readAccessToken: () => null,
      },
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(logs.some((l) => /expose-schemas: skipping/i.test(l))).toBe(true)
  })
})
```

- [ ] **Step 4.3: Run — both new tests should fail**

```bash
npx vitest run tests/scripts/migrate-tier1-to-tier2.test.ts
```

Expected: FAIL — STEPS array doesn't include `'expose-schemas'`.

- [ ] **Step 4.4: Update STEPS array + add the new step handler**

In `scripts/lib/migrate-tier1-to-tier2.mjs`, replace the `STEPS` declaration:

```javascript
export const STEPS = [
  'snapshot',
  'link',
  'push-schema',
  'expose-schemas',
  'restore-data',
  'upload-photos',
  'deploy',
  'rewrite-config',
  'verify',
]
```

Add an import near the other `import * as cloudLink` lines (top of file):

```javascript
import * as supabaseMgmtDefault from './supabase-mgmt.mjs'
```

Add a new `case` in the switch inside `run()` (right after `case 'push-schema':`):

```javascript
      case 'expose-schemas':
        await stepExposeSchemas(cur, deps)
        break
```

Add the step handler near the other `step*` functions:

```javascript
async function stepExposeSchemas(ctx, deps) {
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))
  const mgmt = deps.supabaseMgmt ?? supabaseMgmtDefault
  const token = mgmt.readAccessToken()
  if (!token) {
    log('  expose-schemas: skipping (no Supabase access token; add `plannen` to Data API → Exposed Schemas in the dashboard)')
    return
  }
  if (!ctx.projectRef) throw new Error('expose-schemas requires ctx.projectRef')
  await mgmt.setExposedSchemas(token, ctx.projectRef, ['plannen', 'public', 'graphql_public'])
  log('  expose-schemas: ✓ plannen,public,graphql_public')
}
```

- [ ] **Step 4.5: Run — tests should pass**

```bash
npx vitest run tests/scripts/migrate-tier1-to-tier2.test.ts
```

Expected: PASS for all tests including the two new ones.

- [ ] **Step 4.6: Commit**

```bash
git add scripts/lib/migrate-tier1-to-tier2.mjs tests/scripts/migrate-tier1-to-tier2.test.ts
git commit -m "feat(tier-2/B.2.1): expose-schemas step (PostgREST plannen via Management API)"
```

---

## Task 5: Add `wire-auth` step to the migration orchestrator

**Files:**
- Modify: `scripts/lib/migrate-tier1-to-tier2.mjs`
- Modify: `tests/scripts/migrate-tier1-to-tier2.test.ts`

After `rewrite-config` (which we've already added — it writes the cloud URL into `.env`), the new `wire-auth` step calls `supabase-mgmt.updateAuthConfig(...)` to set `site_url` and add the localhost wildcard to the allow-list. Idempotent. Skips on missing token.

- [ ] **Step 5.1: Update the STEPS-order assertion test (again)**

In `tests/scripts/migrate-tier1-to-tier2.test.ts`, update the STEPS assertion to 10 entries:

```typescript
  it('lists 10 named steps in spec order', () => {
    expect(STEPS).toEqual([
      'snapshot',
      'link',
      'push-schema',
      'expose-schemas',
      'restore-data',
      'upload-photos',
      'deploy',
      'rewrite-config',
      'wire-auth',
      'verify',
    ])
  })
```

- [ ] **Step 5.2: Add focused tests for `wire-auth`**

Append:

```typescript
describe('stepWireAuth (via run)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plannen-wire-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('calls updateAuthConfig with siteUrl=localhost + localhost wildcard', async () => {
    const calls: any[] = []
    const deps = {
      log: () => {},
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ tools: [{ name: 'x' }] }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => {},
        updateAuthConfig: async (token: string, ref: string, patch: any) => {
          calls.push({ token, ref, patch })
          return { changed: true }
        },
        readAccessToken: () => 'tok',
      },
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nexpose-schemas\nrestore-data\nupload-photos\ndeploy\nrewrite-config\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(calls).toHaveLength(1)
    expect(calls[0].patch.siteUrl).toBe('http://localhost:4321')
    expect(calls[0].patch.addAllowList).toContain('http://localhost:4321/**')
  })

  it('skips with a log line when no access token is available', async () => {
    const logs: string[] = []
    const deps = {
      log: (s: string) => { logs.push(s) },
      runSnapshot: () => ({ status: 0 }),
      pushSchema: () => ({ status: 0 }),
      restoreData: async () => {},
      cli: () => ({ status: 0, stdout: '', stderr: '' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ tools: [{ name: 'x' }] }) }),
      supabaseMgmt: {
        setExposedSchemas: async () => {},
        updateAuthConfig: async () => { throw new Error('should not be called') },
        readAccessToken: () => null,
      },
    }
    const progressPath = join(root, 'prog.txt')
    writeFileSync(progressPath, 'snapshot\nlink\npush-schema\nexpose-schemas\nrestore-data\nupload-photos\ndeploy\nrewrite-config\n')
    const ctx = {
      progressPath,
      projectRef: 'abcd1234abcd1234abcd',
      cloudSupabaseUrl: 'https://abcd.supabase.co',
      cloudAnonKey: 'anon',
      cloudServiceRoleKey: 'srk',
      cloudDatabaseUrl: 'postgres://u:p@h/d',
      snapshotSqlPath: join(root, 'snap.sql'),
      mcpBearerToken: 'tok',
      tier1DatabaseUrl: 'postgres://x',
      tier1StorageUrl: 'http://x',
      tier1ServiceRoleKey: 'x',
      envPath: join(root, '.env'),
      pluginManifestPath: join(root, 'plugin.json'),
      skipPhotos: true,
    }
    writeFileSync(ctx.snapshotSqlPath, '-- empty\n')
    writeFileSync(ctx.envPath, '')
    writeFileSync(ctx.pluginManifestPath, '{"mcpServers":{}}')
    await run(ctx, deps as any)
    expect(logs.some((l) => /wire-auth: skipping/i.test(l))).toBe(true)
  })
})
```

- [ ] **Step 5.3: Run — should fail**

```bash
npx vitest run tests/scripts/migrate-tier1-to-tier2.test.ts
```

Expected: FAIL.

- [ ] **Step 5.4: Add `wire-auth` to STEPS + add the step handler**

In `scripts/lib/migrate-tier1-to-tier2.mjs`, update `STEPS`:

```javascript
export const STEPS = [
  'snapshot',
  'link',
  'push-schema',
  'expose-schemas',
  'restore-data',
  'upload-photos',
  'deploy',
  'rewrite-config',
  'wire-auth',
  'verify',
]
```

Add a new `case` in the switch (after `case 'rewrite-config':`):

```javascript
      case 'wire-auth':
        await stepWireAuth(cur, deps)
        break
```

Add the handler near `stepExposeSchemas`:

```javascript
async function stepWireAuth(ctx, deps) {
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))
  const mgmt = deps.supabaseMgmt ?? supabaseMgmtDefault
  const token = mgmt.readAccessToken()
  if (!token) {
    log('  wire-auth: skipping (no Supabase access token; set Site URL + Redirect URLs by hand in the dashboard)')
    return
  }
  if (!ctx.projectRef) throw new Error('wire-auth requires ctx.projectRef')
  const result = await mgmt.updateAuthConfig(token, ctx.projectRef, {
    siteUrl: 'http://localhost:4321',
    addAllowList: ['http://localhost:4321/**'],
  })
  if (result.changed) {
    log('  wire-auth: ✓ site_url=http://localhost:4321, allow-list updated')
  } else {
    log('  wire-auth: ✓ already up to date')
  }
}
```

- [ ] **Step 5.5: Run — all migration tests should pass**

```bash
npx vitest run tests/scripts/migrate-tier1-to-tier2.test.ts
```

Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add scripts/lib/migrate-tier1-to-tier2.mjs tests/scripts/migrate-tier1-to-tier2.test.ts
git commit -m "feat(tier-2/B.2.1): wire-auth step (set Site URL + Redirect URLs via Management API)"
```

---

## Task 6: Vercel deploy — non-interactive link + post-deploy auth update

**Files:**
- Modify: `scripts/lib/vercel-deploy.mjs`
- Modify: `tests/scripts/vercel-deploy.test.ts`

Two changes to the Vercel orchestrator: (a) a new `vercelLink({ yes })` helper that runs `vercel link --yes` when `.vercel/` is missing, and (b) a post-deploy hook in `run()` that calls `supabase-mgmt.updateAuthConfig` to set Site URL to the Vercel URL and add `<url>/**` to the allow-list.

- [ ] **Step 6.1: Write the test for `vercelLink`**

Append to `tests/scripts/vercel-deploy.test.ts`:

```typescript
import {
  vercelLink,
} from '../../scripts/lib/vercel-deploy.mjs'

describe('vercelLink', () => {
  it('runs `vercel link --yes` and returns success', () => {
    const calls: any[] = []
    const cli = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: 'Linked to team/proj', stderr: '' }
    }
    const r = vercelLink({ yes: true }, { cli })
    expect(calls[0]).toEqual(['link', '--yes'])
    expect(r.status).toBe(0)
  })

  it('throws with vercel stderr on non-zero exit', () => {
    const cli = () => ({ status: 1, stdout: '', stderr: 'team not found' })
    expect(() => vercelLink({ yes: true }, { cli })).toThrow(/team not found/)
  })
})
```

- [ ] **Step 6.2: Run — should fail**

```bash
npx vitest run tests/scripts/vercel-deploy.test.ts -t vercelLink
```

Expected: FAIL.

- [ ] **Step 6.3: Implement `vercelLink`**

In `scripts/lib/vercel-deploy.mjs`, near `vercelDeploy`:

```javascript
// IO: `vercel link --yes`. Used by run() to auto-link a project on first
// deploy. Fails if the cwd dir name conflicts with an existing project
// the team owns — caller should fall back to instructing manual `vercel
// link`.
export function vercelLink({ yes = true } = {}, { cli = defaultCli } = {}) {
  const args = ['link']
  if (yes) args.push('--yes')
  const r = cli(args)
  if (r.status !== 0) {
    throw new Error(`vercel link → exit ${r.status}: ${r.stderr || r.stdout}`)
  }
  return r
}
```

- [ ] **Step 6.4: Run — should pass**

```bash
npx vitest run tests/scripts/vercel-deploy.test.ts -t vercelLink
```

Expected: PASS.

- [ ] **Step 6.5: Write the test for post-deploy auth update**

Append:

```typescript
describe('run (with post-deploy auth update)', () => {
  it('updates Supabase Auth site_url and allow-list with the Vercel URL', async () => {
    const calls: any[] = []
    const cli = (args: string[]) => {
      if (args[0] === 'whoami') return { status: 0, stdout: 'user', stderr: '' }
      if (args[0] === 'env' && args[1] === 'rm') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'env' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' }
      // `vercel --prod`
      return { status: 0, stdout: 'Production: https://plannen.vercel.app', stderr: '' }
    }
    const cliWithStdin = async () => ({ status: 0, stdout: '', stderr: '' })
    const supabaseMgmt = {
      readAccessToken: () => 'tok',
      updateAuthConfig: async (token: string, ref: string, patch: any) => {
        calls.push({ token, ref, patch })
        return { changed: true }
      },
    }
    const envText = [
      'PLANNEN_TIER=2',
      'SUPABASE_PROJECT_REF=abcd1234abcd1234abcd',
      'VITE_SUPABASE_URL=https://abcd.supabase.co',
      'VITE_SUPABASE_ANON_KEY=anon',
    ].join('\n')
    const out = await run({ envText }, { cli, cliWithStdin, supabaseMgmt, log: () => {} } as any)
    expect(out.deploymentUrl).toBe('https://plannen.vercel.app')
    expect(calls).toHaveLength(1)
    expect(calls[0].ref).toBe('abcd1234abcd1234abcd')
    expect(calls[0].patch.siteUrl).toBe('https://plannen.vercel.app')
    expect(calls[0].patch.addAllowList).toContain('https://plannen.vercel.app/**')
  })

  it('logs a skip note and continues when no access token', async () => {
    const logs: string[] = []
    const cli = (args: string[]) => {
      if (args[0] === 'whoami') return { status: 0, stdout: 'user', stderr: '' }
      if (args[0] === 'env' && args[1] === 'rm') return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: 'Production: https://plannen.vercel.app', stderr: '' }
    }
    const cliWithStdin = async () => ({ status: 0, stdout: '', stderr: '' })
    const supabaseMgmt = {
      readAccessToken: () => null,
      updateAuthConfig: async () => { throw new Error('should not be called') },
    }
    const envText = 'PLANNEN_TIER=2\nSUPABASE_PROJECT_REF=abcd1234abcd1234abcd\nVITE_SUPABASE_URL=https://abcd.supabase.co\nVITE_SUPABASE_ANON_KEY=anon'
    const out = await run({ envText }, { cli, cliWithStdin, supabaseMgmt, log: (s: string) => logs.push(s) } as any)
    expect(out.deploymentUrl).toBe('https://plannen.vercel.app')
    expect(logs.some((l) => /post-deploy auth wire: skipping/i.test(l))).toBe(true)
  })
})
```

- [ ] **Step 6.6: Run — should fail**

```bash
npx vitest run tests/scripts/vercel-deploy.test.ts -t "post-deploy auth"
```

Expected: FAIL.

- [ ] **Step 6.7: Wire post-deploy auth update into `run()`**

In `scripts/lib/vercel-deploy.mjs`, at the top add:

```javascript
import * as supabaseMgmtDefault from './supabase-mgmt.mjs'
```

In `pickEnvForVercel`, also expose `SUPABASE_PROJECT_REF` to the caller. Easier path: don't change `pickEnvForVercel` (it's strictly `VITE_*`). Instead, parse the project ref out of envText in a small helper:

```javascript
// Pure: pull a single key out of an .env body.
export function readEnvKey(envText, key) {
  for (const raw of envText.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m || m[1] !== key) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value
  }
  return null
}
```

In `run()`, after the `vercelDeploy(...)` call and before the final `return`, add:

```javascript
  // Post-deploy: wire Supabase Auth site_url + allow-list to the Vercel URL.
  const mgmt = deps.supabaseMgmt ?? supabaseMgmtDefault
  const token = mgmt.readAccessToken()
  const projectRef = readEnvKey(ctx.envText, 'SUPABASE_PROJECT_REF')
  if (!token) {
    log('  post-deploy auth wire: skipping (no Supabase access token)')
  } else if (!projectRef) {
    log('  post-deploy auth wire: skipping (SUPABASE_PROJECT_REF not in .env)')
  } else if (!url) {
    log('  post-deploy auth wire: skipping (could not parse Vercel URL from stdout)')
  } else {
    await mgmt.updateAuthConfig(token, projectRef, {
      siteUrl: url,
      addAllowList: [`${url.replace(/\/+$/, '')}/**`],
    })
    log(`  post-deploy auth wire: ✓ site_url=${url}`)
  }
```

- [ ] **Step 6.8: Run — should pass**

```bash
npx vitest run tests/scripts/vercel-deploy.test.ts
```

Expected: PASS (all vercel-deploy tests).

- [ ] **Step 6.9: Wire `vercelLink` into the shell script**

In `scripts/vercel-deploy.sh`, replace the `[ ! -d .vercel ]` block:

```bash
if [ ! -d .vercel ]; then
  dim "no .vercel/ found — running: vercel link --yes"
  if ! vercel link --yes; then
    red "vercel link --yes failed — run it manually and re-run this script"
    exit 1
  fi
fi
```

- [ ] **Step 6.10: Commit**

```bash
git add scripts/lib/vercel-deploy.mjs scripts/vercel-deploy.sh tests/scripts/vercel-deploy.test.ts
git commit -m "feat(tier-2/B.2.1): vercel link --yes + post-deploy Auth wiring"
```

---

## Task 7: Bootstrap shell — interactive picker + Vercel offer

**Files:**
- Modify: `scripts/bootstrap.sh`

The shell-side glue. Tier 2 path: if `--project-ref` not passed and we're in interactive mode, shell out to the picker. After the migration orchestrator returns success, prompt "Deploy to Vercel?" and run the deploy if yes. Shell scripts are tested by manual run — the underlying .mjs modules are already unit-tested.

- [ ] **Step 7.1: Read the current Tier 2 section to understand the surrounding flow**

```bash
sed -n '200,300p' scripts/bootstrap.sh
```

You'll see the existing flag-handling for `--project-ref` and `--cloud-db-url`, the `TIER_CHANGE` logic, and the orchestrator invocation. New behaviour goes around those.

- [ ] **Step 7.2: Replace the project-ref + cloud-db-url acquisition**

Find the block that currently *requires* `PROJECT_REF` and `CLOUD_DB_URL` to have been passed as flags (the validation happens just before "Running Tier 1 → Tier 2 migration orchestrator"). Insert this *before* that validation:

```bash
# Tier 2 interactive bootstrap: pick a project + prompt for password.
if [ "$TIER" = "2" ] && [ "$INTERACTIVE" = "1" ] && [ -z "$PROJECT_REF" ]; then
  step "Selecting Supabase Cloud project"
  if ! command -v supabase >/dev/null 2>&1; then
    red "supabase CLI not found — install with: brew install supabase/tap/supabase"
    exit 1
  fi
  if ! supabase --version >/dev/null 2>&1; then
    red "supabase CLI is broken — try reinstalling"
    exit 1
  fi
  # The picker shells out to /dev/tty for the menu and emits JSON on stdout.
  PICKED_JSON=$(node scripts/lib/cloud-project-picker.mjs) || {
    red "project picker failed"
    exit 1
  }
  PROJECT_REF=$(printf '%s' "$PICKED_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["ref"])')
  PICKED_REGION=$(printf '%s' "$PICKED_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["region"])')
  green "  selected: $PROJECT_REF ($PICKED_REGION)"
fi

if [ "$TIER" = "2" ] && [ -z "$CLOUD_DB_URL" ] && [ -n "$PROJECT_REF" ] && [ -n "$PICKED_REGION" ]; then
  step "DB password (won't echo)"
  # CLOUD_DB_PASSWORD overrides the prompt for CI.
  if [ -z "${CLOUD_DB_PASSWORD:-}" ]; then
    printf "  postgres password for %s: " "$PROJECT_REF" > /dev/tty
    stty -echo
    read -r CLOUD_DB_PASSWORD < /dev/tty
    stty echo
    printf "\n" > /dev/tty
  fi
  CLOUD_DB_URL=$(node -e '
    import("./scripts/lib/cloud-db-url.mjs").then(m => {
      process.stdout.write(m.buildPoolerUrl({
        projectRef: process.env.PR,
        region: process.env.RG,
        password: process.env.PW,
      }))
    }).catch(e => { console.error(e.message); process.exit(1) })
  ' PR="$PROJECT_REF" RG="$PICKED_REGION" PW="$CLOUD_DB_PASSWORD") || {
    red "failed to build pooler URL"
    exit 1
  }
fi
```

This block runs only on `--tier 2`, only when interactive, only when the flags weren't given. CI users passing `--project-ref` + `--cloud-db-url` keep the old path.

- [ ] **Step 7.3: Add the Vercel offer after a successful orchestrator run**

After the orchestrator invocation (after the `node scripts/lib/migrate-tier1-to-tier2.mjs` call exits 0 and the "Tier 2 migration complete" success line is printed), insert:

```bash
if [ "$TIER" = "2" ] && [ "$INTERACTIVE" = "1" ] && [ "${SKIP_VERCEL:-0}" != "1" ]; then
  step "Deploy web app to Vercel?"
  printf "  [Y/n] " > /dev/tty
  read -r VERCEL_ANSWER < /dev/tty || VERCEL_ANSWER=""
  case "$VERCEL_ANSWER" in
    n|N|no|NO) dim "  skipped — run \`bash scripts/vercel-deploy.sh\` later" ;;
    *)
      if ! command -v vercel >/dev/null 2>&1; then
        red "  vercel CLI not found — install with: npm i -g vercel"
        dim "  then run: bash scripts/vercel-deploy.sh"
      elif ! vercel whoami >/dev/null 2>&1; then
        red "  vercel CLI not logged in — run: vercel login"
        dim "  then run: bash scripts/vercel-deploy.sh"
      else
        bash scripts/vercel-deploy.sh
      fi
      ;;
  esac
fi
```

- [ ] **Step 7.4: Add `--skip-vercel` flag parsing**

Find the existing flag-parsing loop at the top of `scripts/bootstrap.sh` and add a `--skip-vercel` case:

```bash
    --skip-vercel)
      SKIP_VERCEL=1
      shift
      ;;
```

Initialise `SKIP_VERCEL=0` near the other variable initialisations.

- [ ] **Step 7.5: Manual smoke test — interactive picker (skip if you don't have a fresh Supabase project handy)**

If you have a second Supabase Cloud project available, you can dry-run:

```bash
# Inspect the picker in isolation:
node scripts/lib/cloud-project-picker.mjs
```

Expected: menu rendered, you can pick, JSON printed to stdout. Skip this step if you only have one project — re-running bootstrap against the existing project tests the same code path.

- [ ] **Step 7.6: Manual smoke test — full bootstrap path**

Delete the resume progress file (the migration is already done on this machine, so this just re-tests the bash glue):

```bash
ls .plannen-tier2-progress 2>/dev/null && rm .plannen-tier2-progress
# Re-run bootstrap with NO flags (interactive picker + password prompt):
bash scripts/bootstrap.sh --tier 2
```

Expected:
- Picker menu appears.
- Password prompt appears (typed chars don't echo).
- Migration orchestrator runs, exits 0.
- "Deploy web app to Vercel?" prompt appears.
- Answering "n" exits cleanly with a hint.

- [ ] **Step 7.7: Commit**

```bash
git add scripts/bootstrap.sh
git commit -m "feat(tier-2/B.2.1): interactive project picker + vercel offer in bootstrap"
```

---

## Task 8: Cloud-doctor — two new checks

**Files:**
- Modify: `scripts/cloud-doctor.mjs`
- Test: `tests/scripts/cloud-doctor.test.ts` (create if missing)

Two new checks against the live cloud project: PostgREST exposes `plannen`, and Auth `site_url` matches a known-good URL. Both use the Management API helpers from Task 1.

- [ ] **Step 8.1: Check if the test file exists**

```bash
ls tests/scripts/cloud-doctor.test.ts 2>/dev/null || echo MISSING
```

If MISSING, create it with the imports:

```typescript
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs module
import {
  checkPlannenSchemaExposed,
  checkAuthSiteUrl,
} from '../../scripts/cloud-doctor.mjs'
```

If it exists, just append.

- [ ] **Step 8.2: Write the test for `checkPlannenSchemaExposed`**

Append:

```typescript
describe('checkPlannenSchemaExposed', () => {
  it('passes when /rest/v1/?schema=plannen returns 200', async () => {
    const fakeFetch = async (url: string, init: any) => {
      return { ok: true, status: 200, json: async () => ({ paths: { '/events': {} } }) }
    }
    const r = await checkPlannenSchemaExposed({ supabaseUrl: 'https://abcd.supabase.co', anonKey: 'k' }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(true)
  })

  it('fails with PGRST106 detail when the schema is not exposed', async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 406,
      json: async () => ({ code: 'PGRST106', message: 'Invalid schema: plannen' }),
    })
    const r = await checkPlannenSchemaExposed({ supabaseUrl: 'https://abcd.supabase.co', anonKey: 'k' }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/plannen.*not exposed/i)
  })
})

describe('checkAuthSiteUrl', () => {
  it('passes when site_url matches an expected value', async () => {
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:4321', uri_allow_list: '' }) })
    const r = await checkAuthSiteUrl({
      projectRef: 'ref',
      accessToken: 'tok',
      expectedUrls: ['http://localhost:4321', 'https://plannen.vercel.app'],
    }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(true)
  })

  it('fails when site_url is the Supabase localhost default (3000)', async () => {
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ site_url: 'http://localhost:3000', uri_allow_list: '' }) })
    const r = await checkAuthSiteUrl({
      projectRef: 'ref',
      accessToken: 'tok',
      expectedUrls: ['http://localhost:4321', 'https://plannen.vercel.app'],
    }, { fetch: fakeFetch as any })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/site_url is "http:\/\/localhost:3000"/)
  })

  it('skips cleanly when no access token is provided', async () => {
    const r = await checkAuthSiteUrl({
      projectRef: 'ref',
      accessToken: null,
      expectedUrls: [],
    })
    expect(r.ok).toBe(true)
    expect(r.reason).toMatch(/skipped/i)
  })
})
```

- [ ] **Step 8.3: Run — should fail**

```bash
npx vitest run tests/scripts/cloud-doctor.test.ts
```

Expected: FAIL — functions not exported.

- [ ] **Step 8.4: Implement the two checks**

In `scripts/cloud-doctor.mjs`, add near the other `check*` helpers:

```javascript
// Pure-ish: probe PostgREST with a `Accept-Profile: plannen` request and
// look for the PGRST106 "Invalid schema" error code which means the
// schema isn't in the `db_schema` allow-list.
export async function checkPlannenSchemaExposed({ supabaseUrl, anonKey }, { fetch = globalThis.fetch } = {}) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/`
  const res = await fetch(url, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Accept-Profile': 'plannen',
    },
  })
  if (res.ok) return { ok: true, reason: '' }
  const body = await res.json().catch(() => ({}))
  if (body?.code === 'PGRST106') {
    return { ok: false, reason: 'schema `plannen` not exposed (add it under Data API → Exposed Schemas, or re-run bootstrap)' }
  }
  return { ok: false, reason: `unexpected PostgREST response: HTTP ${res.status}` }
}

// Pure-ish: read Auth config via Management API and confirm site_url is
// one of the URLs the user is actually using. Skipped if no access token.
export async function checkAuthSiteUrl({ projectRef, accessToken, expectedUrls }, { fetch = globalThis.fetch } = {}) {
  if (!accessToken) {
    return { ok: true, reason: 'skipped (no Supabase access token)' }
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return { ok: false, reason: `Management API returned HTTP ${res.status}` }
  const cfg = await res.json()
  if (expectedUrls.includes(cfg.site_url)) return { ok: true, reason: '' }
  return { ok: false, reason: `site_url is "${cfg.site_url}", expected one of: ${expectedUrls.join(', ')}` }
}
```

- [ ] **Step 8.5: Wire the new checks into the doctor's main flow**

Find the `main()` function (or equivalent — search for the line that ends with `process.exit(failures > 0 ? 1 : 0)`). Add two new check invocations just before the photo-count parity check:

```javascript
  // Check: PostgREST exposes plannen.
  const exposedRes = await checkPlannenSchemaExposed({
    supabaseUrl: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
  })
  print(exposedRes.ok, 'PostgREST exposes plannen schema', exposedRes.reason)
  if (!exposedRes.ok) failures++

  // Check: Auth site_url is sensible.
  const { readAccessToken } = await import('./lib/supabase-mgmt.mjs')
  const siteRes = await checkAuthSiteUrl({
    projectRef: process.env.SUPABASE_PROJECT_REF,
    accessToken: readAccessToken(),
    expectedUrls: [
      'http://localhost:4321',
      ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
      ...(process.env.SUPABASE_AUTH_SITE_URL ? [process.env.SUPABASE_AUTH_SITE_URL] : []),
    ],
  })
  print(siteRes.ok, 'Auth Site URL configured', siteRes.reason)
  if (!siteRes.ok) failures++
```

(`print` and `failures` are the existing pattern in cloud-doctor.mjs — verify with `grep "failures++\|print(" scripts/cloud-doctor.mjs | head` first.)

- [ ] **Step 8.6: Run the cloud-doctor tests + a smoke run against the live project**

```bash
npx vitest run tests/scripts/cloud-doctor.test.ts
```

Expected: PASS.

```bash
node scripts/cloud-doctor.mjs
```

Expected: ✓ on both new checks (since Task 4 + Task 5 already wired the live project). If `Auth Site URL` shows the Vercel URL after Task 7 has been used, also ✓.

- [ ] **Step 8.7: Commit**

```bash
git add scripts/cloud-doctor.mjs tests/scripts/cloud-doctor.test.ts
git commit -m "feat(tier-2/B.2.1): cloud-doctor checks for exposed-schemas + Auth site_url"
```

---

## Task 9: README + spec status update

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-05-17-tier-2-bootstrap-automation-design.md`

Document the new interactive flow as the default. Keep the flag-based form documented for CI.

- [ ] **Step 9.1: Update the Tier 2 setup section in README.md**

Find the `### Tier 2 (cloud, opt-in)` section. Replace the leading example block:

````markdown
### Tier 2 (cloud, opt-in)

After installing the Supabase CLI and running `supabase login`, migrate to your Supabase Cloud project:

```bash
bash scripts/bootstrap.sh --tier 2
```

The script will:

1. Show a numbered menu of Supabase projects your account can see — pick one.
2. Prompt for the DB password (`postgres` user, set when you created the project). The password is not echoed and is not persisted.
3. Snapshot Tier 1, link cloud, push schema, expose `plannen` via PostgREST, restore data, upload photos, deploy edge functions, rewrite local config, wire Auth Site URL + Redirect URLs.
4. Ask if you want to deploy the web app to Vercel — answer Y to run the deploy inline.

Non-interactive / CI form (skips the picker and the Vercel offer):

```bash
bash scripts/bootstrap.sh --tier 2 \
  --non-interactive \
  --project-ref <your-project-ref> \
  --cloud-db-url 'postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres' \
  --skip-vercel
```
````

- [ ] **Step 9.2: Remove the obsolete manual post-deploy checklist**

Still in `README.md`, find the post-deploy checklist that says "Add `https://<your-ref>.supabase.co/functions/v1/google-oauth-callback` to your Google Cloud OAuth client" and the "Add plannen to Exposed Schemas" instructions if present. Trim the parts that are now automatic, leave only the items that genuinely need the user (Google OAuth callback URL, custom SMTP, custom Vercel domain).

- [ ] **Step 9.3: Update the spec status**

In `docs/superpowers/specs/2026-05-17-tier-2-bootstrap-automation-design.md`, change the status header from `Spec only.` to `Implemented in branch <branch-name>.` (read your current branch name with `git branch --show-current`).

- [ ] **Step 9.4: Final full test pass**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 9.5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-05-17-tier-2-bootstrap-automation-design.md
git commit -m "docs(tier-2/B.2.1): README + spec status for bootstrap automation"
```

---

## Done criteria

- `bash scripts/bootstrap.sh --tier 2` on a clean account walks the user through pick-project → password → migration → "deploy to Vercel?" with no flag arguments required.
- Re-runs of bootstrap on an already-migrated project are no-ops for `expose-schemas` and `wire-auth` (idempotent Management API PATCHes).
- `node scripts/cloud-doctor.mjs` reports ✓ for the new schema-exposure + Auth site_url checks against a real Tier 2 install.
- `npx vitest run` passes.
- Non-interactive / CI form (`--project-ref … --cloud-db-url … --non-interactive --skip-vercel`) still works.

## Self-review notes

Spec coverage — each spec section maps to a task: Management API helper → Task 1. Pooler URL builder → Task 2. Project picker → Task 3. Orchestrator new steps → Tasks 4, 5. Vercel non-interactive link + post-deploy Auth wiring → Task 6. Bootstrap shell wiring → Task 7. cloud-doctor new checks → Task 8. Docs → Task 9.

Out-of-scope items (SMTP, custom domain, `vercel login`, `supabase login`) deliberately have no tasks — they stay manual.

Type consistency — `supabaseMgmt` is the dep-injection key in Tasks 4, 5, 6, and 8. `readAccessToken`, `setExposedSchemas`, `updateAuthConfig` are the function names everywhere. `addAllowList` (not `additionalRedirectUrls`) is the `updateAuthConfig` patch key across Tasks 1, 5, 6.
