#!/usr/bin/env node
// Tier 1 → Tier 2 migration orchestrator.
//
// Runs the ten steps in the spec at
// docs/superpowers/specs/2026-05-16-tier-2-cloud-deploy-design.md:
//
//   1. snapshot Tier 1 (delegates to scripts/lib/snapshot.mjs)
//   2. link cloud (cloud-link.mjs)
//   3. push schema (supabase db push)
//   4. expose schemas (supabase-mgmt.mjs — adds plannen to PostgREST)
//   5. restore data into cloud DB (psql against cloud DATABASE_URL)
//   6. upload photos (storage-cloud-upload.mjs)
//   7. deploy functions + set secrets (cloud-deploy.mjs)
//   8. rewrite local .env + plugin.json (backs up first)
//   9. wire auth (site_url + redirect allow-list via Management API)
//  10. verify (delegates to cloud-doctor.mjs once that's wired in)
//
// Idempotent + resumable via .plannen-tier2-progress in repo root. Each
// completed step appends its name. Re-running skips any step already done.
//
// All shellouts and DB ops are dep-injected so the test harness can drive
// the full orchestrator without touching anything real.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import os from 'node:os'
import pg from 'pg'

import * as cloudLink from './cloud-link.mjs'
import * as cloudDeploy from './cloud-deploy.mjs'
import * as storageUpload from './storage-cloud-upload.mjs'
import * as supabaseMgmtDefault from './supabase-mgmt.mjs'
import { mintToken as defaultMintToken } from './userTokens.mjs'
import { getProfileManifestPath } from '../../cli/lib/profiles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const DEFAULT_PROGRESS_PATH = join(REPO_ROOT, '.plannen-tier2-progress')

// Step names. Order matters for resume.
export const STEPS = [
  'snapshot',
  'link',
  'push-schema',
  'expose-schemas',
  'restore-data',
  'rewrite-storage-urls',
  'upload-photos',
  'deploy',
  'mint-pat',
  'rewrite-config',
  'wire-auth',
  'verify',
]

// Pure: parse the progress file into a Set of completed step names.
export function readProgress(path) {
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
}

// Pure: append a step name (with newline) to the progress file.
export function markProgress(path, step) {
  appendFileSync(path, `${step}\n`)
}

// Pure: which steps still need running.
export function pendingSteps(allSteps, done) {
  return allSteps.filter((s) => !done.has(s))
}

// Pure: render the .env file content with overridden / appended keys.
// Preserves existing key order; new keys appended at the end.
export function rewriteEnvContent(currentText, updates) {
  const lines = currentText.split('\n')
  const keysSet = new Set(Object.keys(updates))
  const seen = new Set()
  const out = lines.map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!m) return line
    const key = m[1]
    if (keysSet.has(key)) {
      seen.add(key)
      return `${key}=${updates[key]}`
    }
    return line
  })
  for (const key of keysSet) {
    if (!seen.has(key)) out.push(`${key}=${updates[key]}`)
  }
  return out.join('\n')
}

// Pure: render the plugin manifest in HTTP mode for the cloud MCP URL.
// Preserves any fields not relevant to mcpServers.plannen.
export function rewritePluginManifest(currentJson, { cloudUrl, bearer }) {
  const data = JSON.parse(currentJson)
  data.mcpServers = data.mcpServers ?? {}
  data.mcpServers.plannen = {
    type: 'http',
    url: `${cloudUrl.replace(/\/+$/, '')}/functions/v1/mcp`,
    headers: { Authorization: `Bearer ${bearer}` },
  }
  return JSON.stringify(data, null, 2) + '\n'
}

// Pure: build cloud DB URL hint when only the project ref is known.
// Used for the user-facing prompt only; the orchestrator requires the full
// URL with the password to actually connect.
export function cloudDbUrlHint(projectRef) {
  return `postgresql://postgres.${projectRef}:[YOUR-PASSWORD]@aws-0-region.pooler.supabase.com:6543/postgres`
}

// IO: spawn the snapshot helper.
function defaultRunSnapshot(args) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/lib/snapshot.mjs'), ...args], {
    stdio: 'inherit',
  })
}

// IO: spawn `supabase db push`. The repo is already linked by the prior `link`
// step, so `--linked` (the default) targets the right project. `db push` does
// not accept `--project-ref`.
function defaultPushSchema(_projectRef) {
  return spawnSync(
    'supabase',
    ['db', 'push', '--linked'],
    { stdio: 'inherit' },
  )
}

// IO: psql multi-statement apply against the cloud DB.
async function defaultRestoreData({ cloudDatabaseUrl, sqlText, forceOverwrite, ClientCtor }) {
  const Client = ClientCtor ?? pg.Client
  const client = new Client({ connectionString: cloudDatabaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM plannen.events",
    )
    if (rows[0].n > 0 && !forceOverwrite) {
      throw new Error(
        `cloud db non-empty (plannen.events has ${rows[0].n} row(s)); ` +
          `pass --force-overwrite to confirm replacement`,
      )
    }
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    if (rows[0].n > 0) {
      // forceOverwrite path: wipe in topo order before restore.
      await client.query(
        `TRUNCATE TABLE plannen.audit_log, plannen.profile_facts,
                          plannen.story_events, plannen.stories,
                          plannen.event_source_refs, plannen.event_sources,
                          plannen.event_memories, plannen.event_rsvps,
                          plannen.event_shared_with_groups,
                          plannen.event_shared_with_users,
                          plannen.event_invites, plannen.events,
                          plannen.family_members, plannen.relationships,
                          plannen.friend_group_members, plannen.friend_groups,
                          plannen.user_locations, plannen.user_oauth_tokens,
                          plannen.user_settings, plannen.user_profiles,
                          plannen.users, plannen.agent_tasks,
                          plannen.app_allowed_emails, plannen.oauth_state
            RESTART IDENTITY CASCADE`,
      )
    }
    await client.query(sqlText)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    await client.end()
  }
}

// Top-level orchestrator.
export async function run(ctx = {}, deps = {}) {
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))
  const progressPath = ctx.progressPath ?? DEFAULT_PROGRESS_PATH
  let done = readProgress(progressPath)
  let pending = pendingSteps(STEPS, done)

  // If the previous run completed every step in the current STEPS list, treat
  // this invocation as a fresh start — reset progress and re-run everything.
  // Without this, a successful prior run silently skips local-state steps
  // (notably rewrite-config) when the user re-enters tier-2 from another tier
  // with a stale .env.
  if (done.size > 0 && pending.length === 0) {
    log('  previous tier-2 run completed — resetting progress to re-run all steps')
    rmSync(progressPath, { force: true })
    done = new Set()
    pending = STEPS.slice()
  }

  let cur = { ...ctx }

  // Rehydrate link-derived ctx fields if link already ran in a prior session.
  // The link step is idempotent and downstream steps (upload-photos, deploy,
  // rewrite-config, verify) all need cloudSupabaseUrl + cloud API keys.
  if (cur.projectRef && !cur.cloudSupabaseUrl && done.has('link')) {
    cur = await cloudLink.run(cur, deps)
  }

  for (const step of pending) {
    log(`▸ step: ${step}`)
    switch (step) {
      case 'snapshot':
        cur = await stepSnapshot(cur, deps)
        break
      case 'link':
        cur = await stepLink(cur, deps)
        break
      case 'push-schema':
        await stepPushSchema(cur, deps)
        break
      case 'expose-schemas':
        await stepExposeSchemas(cur, deps)
        break
      case 'restore-data':
        await stepRestoreData(cur, deps)
        break
      case 'rewrite-storage-urls':
        await stepRewriteStorageUrls(cur, deps)
        break
      case 'upload-photos':
        cur = await stepUploadPhotos(cur, deps)
        break
      case 'deploy':
        cur = await stepDeploy(cur, deps)
        break
      case 'mint-pat':
        cur = await stepMintPat(cur, deps)
        break
      case 'rewrite-config':
        await stepRewriteConfig(cur, deps)
        break
      case 'wire-auth':
        await stepWireAuth(cur, deps)
        break
      case 'verify':
        await stepVerify(cur, deps)
        break
      default:
        throw new Error(`unknown step: ${step}`)
    }
    markProgress(progressPath, step)
  }

  return { ...cur, doneSteps: STEPS.slice() }
}

// ── Step wrappers ──────────────────────────────────────────────────────────

async function stepSnapshot(ctx, deps) {
  if (ctx.skipSnapshot) return ctx
  const runSnapshot = deps.runSnapshot ?? defaultRunSnapshot
  const out = ctx.snapshotDir ?? join(REPO_ROOT, '.plannen', 'snapshots')
  mkdirSync(out, { recursive: true })
  const r = runSnapshot(['--tier', '1', '--out', out, '--keep', '5'])
  if (r.status !== 0) throw new Error(`snapshot failed (exit ${r.status})`)
  const next = { ...ctx }
  if (!next.snapshotSqlPath) {
    const latest = findLatestSnapshotSql(out)
    if (latest) next.snapshotSqlPath = latest
  }
  return next
}

// Pure-ish: scan a snapshot dir for the newest `<ISO>.sql.gz` file.
function findLatestSnapshotSql(dir) {
  if (!existsSync(dir)) return null
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.sql\.gz$/
  let best = null
  let bestMtime = -1
  for (const name of readdirSync(dir)) {
    if (!re.test(name)) continue
    const full = join(dir, name)
    const m = statSync(full).mtimeMs
    if (m > bestMtime) {
      bestMtime = m
      best = full
    }
  }
  return best
}

async function stepLink(ctx, deps) {
  return cloudLink.run(ctx, deps)
}

async function stepPushSchema(ctx, deps) {
  if (!ctx.projectRef) throw new Error('push-schema requires ctx.projectRef')
  const push = deps.pushSchema ?? defaultPushSchema
  const r = push(ctx.projectRef)
  if (r.status !== 0) throw new Error(`supabase db push failed (exit ${r.status})`)
}

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

async function stepRestoreData(ctx, deps) {
  if (!ctx.cloudDatabaseUrl) {
    throw new Error(
      'restore-data requires ctx.cloudDatabaseUrl (full pg URL with password); ' +
        `hint: ${cloudDbUrlHint(ctx.projectRef ?? '<ref>')}`,
    )
  }
  if (!ctx.snapshotSqlPath) {
    // Resume path: snapshot step already ran and marked itself done, so ctx
    // wasn't carried forward. Recover by scanning the snapshot dir.
    const out = ctx.snapshotDir ?? join(REPO_ROOT, '.plannen', 'snapshots')
    const latest = findLatestSnapshotSql(out)
    if (!latest) throw new Error('restore-data requires ctx.snapshotSqlPath')
    ctx = { ...ctx, snapshotSqlPath: latest }
  }
  const sqlText = ctx.snapshotSqlPath.endsWith('.gz')
    ? gunzipSync(readFileSync(ctx.snapshotSqlPath)).toString('utf8')
    : readFileSync(ctx.snapshotSqlPath, 'utf8')
  const restore = deps.restoreData ?? defaultRestoreData
  await restore({
    cloudDatabaseUrl: ctx.cloudDatabaseUrl,
    sqlText,
    forceOverwrite: ctx.forceOverwrite === true,
    ClientCtor: deps.Client,
  })
}

// Rewrites any media_url / cover_url values that still point at the Tier 1
// local Supabase storage URL to use the cloud URL instead. Without this, the
// `event_memories.media_url` rows restored from the Tier 1 snapshot still
// reference http://127.0.0.1:54321/... — those resolve on the developer's
// own machine (Tier 1 is still up) but not from a phone or any other browser.
async function stepRewriteStorageUrls(ctx, deps) {
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))
  if (!ctx.cloudDatabaseUrl) throw new Error('rewrite-storage-urls requires ctx.cloudDatabaseUrl')
  if (!ctx.cloudSupabaseUrl) throw new Error('rewrite-storage-urls requires ctx.cloudSupabaseUrl')
  const cloudPrefix = `${ctx.cloudSupabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/`
  const sourcePrefixes = ctx.tier1StoragePrefixes ?? [
    'http://127.0.0.1:54321/storage/v1/object/public/',
    'http://localhost:54321/storage/v1/object/public/',
  ]
  const rewrite = deps.rewriteStorageUrls ?? defaultRewriteStorageUrls
  const counts = await rewrite({
    cloudDatabaseUrl: ctx.cloudDatabaseUrl,
    sourcePrefixes,
    cloudPrefix,
    ClientCtor: deps.Client,
  })
  log(`  rewrite-storage-urls: ✓ memories=${counts.memories}, stories=${counts.stories}`)
}

async function defaultRewriteStorageUrls({ cloudDatabaseUrl, sourcePrefixes, cloudPrefix, ClientCtor }) {
  const Client = ClientCtor ?? pg.Client
  const client = new Client({ connectionString: cloudDatabaseUrl })
  await client.connect()
  try {
    let memories = 0
    let stories = 0
    for (const src of sourcePrefixes) {
      const m = await client.query(
        `UPDATE plannen.event_memories
            SET media_url = replace(media_url, $1, $2)
          WHERE media_url LIKE $1 || '%'`,
        [src, cloudPrefix],
      )
      memories += m.rowCount ?? 0
      const s = await client.query(
        `UPDATE plannen.stories
            SET cover_url = replace(cover_url, $1, $2)
          WHERE cover_url LIKE $1 || '%'`,
        [src, cloudPrefix],
      )
      stories += s.rowCount ?? 0
    }
    return { memories, stories }
  } finally {
    await client.end()
  }
}

async function stepUploadPhotos(ctx, deps) {
  return storageUpload.run(ctx, deps)
}

async function stepDeploy(ctx, deps) {
  return cloudDeploy.run(ctx, deps)
}

// Mints the admin's first per-user PAT against the freshly-deployed cloud DB
// and stashes the plaintext on ctx.mcpBearerToken so the downstream
// rewrite-config + verify steps use a token the new MCP function will accept.
//
// Best-effort: if any prerequisite is missing or the DB call throws, log and
// fall through with the original ctx.mcpBearerToken (the orchestrator's verify
// step will then surface the actual problem). The PAT branch removed the
// shared MCP_BEARER_TOKEN path, so on a fresh sb_prod the legacy bearer that
// init carries from .env returns 401 — this step is what closes that gap.
async function stepMintPat(ctx, deps) {
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))
  if (!ctx.cloudDatabaseUrl) {
    log('  mint-pat: skipped (cloudDatabaseUrl not set)')
    return ctx
  }
  if (!ctx.userEmail) {
    log('  mint-pat: skipped (userEmail not set)')
    return ctx
  }
  const ClientCtor = deps.Client ?? pg.Client
  const mintFn = deps.mintToken ?? defaultMintToken
  const client = new ClientCtor({ connectionString: ctx.cloudDatabaseUrl })
  try {
    await client.connect()
    const { rows } = await client.query(
      'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
      [ctx.userEmail],
    )
    if (rows.length === 0) {
      log(`  mint-pat: skipped (plannen.users has no row for ${ctx.userEmail} — mint a PAT manually from /settings)`)
      return ctx
    }
    const label = `init-${os.hostname()}`
    const r = await mintFn(client, rows[0].id, label)
    log(`  mint-pat: ✓ minted PAT "${label}" (prefix ${r.prefix})`)
    return { ...ctx, mcpBearerToken: r.plaintext }
  } catch (e) {
    log(`  mint-pat: skipped (${e.message ?? e}) — verify will fail if the stale bearer is still in use`)
    return ctx
  } finally {
    try { await client.end() } catch { /* ignore close errors */ }
  }
}

async function stepRewriteConfig(ctx, deps) {
  if (!ctx.projectRef) throw new Error('rewrite-config requires ctx.projectRef')
  if (!ctx.mcpBearerToken) throw new Error('rewrite-config requires ctx.mcpBearerToken')
  if (!ctx.cloudSupabaseUrl) throw new Error('rewrite-config requires ctx.cloudSupabaseUrl')
  if (!ctx.cloudAnonKey) throw new Error('rewrite-config requires ctx.cloudAnonKey')

  const envPath = ctx.envPath ?? join(REPO_ROOT, '.env')
  const envLocalPath = ctx.envLocalPath ?? join(REPO_ROOT, '.env.local')
  const pluginPath =
    ctx.pluginManifestPath ?? join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

  // Back up first (Tier 1 → 2 only; fresh installs may not have these).
  if (existsSync(envPath) && !existsSync(`${envPath}.tier1.bak`)) {
    copyFileSync(envPath, `${envPath}.tier1.bak`)
  }
  if (existsSync(pluginPath) && !existsSync(`${pluginPath}.tier1.bak`)) {
    copyFileSync(pluginPath, `${pluginPath}.tier1.bak`)
  }
  // Vite loads .env.local AFTER .env, so its values override. `supabase start`
  // writes .env.local with local URLs; if we leave it in place after migration,
  // `npm run dev` keeps talking to local Tier 1 even though .env says cloud.
  if (existsSync(envLocalPath) && !existsSync(`${envLocalPath}.tier1.bak`)) {
    copyFileSync(envLocalPath, `${envLocalPath}.tier1.bak`)
    rmSync(envLocalPath)
  }

  const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const updated = rewriteEnvContent(envText, {
    PLANNEN_TIER: '2',
    SUPABASE_PROJECT_REF: ctx.projectRef,
    SUPABASE_URL: ctx.cloudSupabaseUrl,
    SUPABASE_ANON_KEY: ctx.cloudAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: ctx.cloudServiceRoleKey ?? '',
    VITE_SUPABASE_URL: ctx.cloudSupabaseUrl,
    VITE_SUPABASE_ANON_KEY: ctx.cloudAnonKey,
    VITE_PLANNEN_TIER: '2',
    VITE_PLANNEN_BACKEND_MODE: 'supabase',
    MCP_BEARER_TOKEN: ctx.mcpBearerToken,
  })
  writeFileSync(envPath, updated)

  if (existsSync(pluginPath)) {
    const pluginText = readFileSync(pluginPath, 'utf8')
    const next = rewritePluginManifest(pluginText, {
      cloudUrl: ctx.cloudSupabaseUrl,
      bearer: ctx.mcpBearerToken,
    })
    writeFileSync(pluginPath, next)
  }

  // Sync the active profile's manifest.mode to cloud_sb. Without this the
  // manifest keeps its creation-time value (e.g. local_pg) even though we
  // just flipped the env to tier 2 — issue #23.
  const manifestPath =
    ctx.profileManifestPath ??
    (process.env.PLANNEN_PROFILE
      ? getProfileManifestPath(process.env.PLANNEN_PROFILE, process.env)
      : null)
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (m.mode !== 'cloud_sb') {
        writeFileSync(manifestPath, JSON.stringify({ ...m, mode: 'cloud_sb' }, null, 2) + '\n')
      }
    } catch {
      // Malformed manifest is not worth aborting a tier migration over.
    }
  }

  void deps
}

async function stepVerify(ctx, deps) {
  // The cloud-doctor module lives one task over; until it lands we do the
  // minimum check inline: tools/list ≥ 1 over the cloud MCP URL with bearer.
  const fetch = deps.fetch ?? globalThis.fetch
  const url = `${ctx.cloudSupabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.mcpBearerToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  if (!res.ok) {
    throw new Error(`verify: cloud MCP returned HTTP ${res.status}`)
  }
  const ct = res.headers?.get?.('content-type') ?? ''
  let body
  if (ct.includes('text/event-stream')) {
    // Parse SSE: take the first `data:` line and JSON-decode it.
    const text = await res.text()
    const dataLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'))
    if (!dataLine) throw new Error('verify: cloud MCP SSE response had no data frame')
    body = JSON.parse(dataLine.slice('data:'.length).trim())
  } else {
    body = await res.json()
  }
  const tools = body?.result?.tools ?? []
  if (tools.length < 1) {
    throw new Error('verify: cloud MCP tools/list returned 0 tools')
  }
}

// CLI entry — wires env → ctx for manual runs.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const ctx = {
      projectRef: process.env.SUPABASE_PROJECT_REF,
      cloudDatabaseUrl: process.env.CLOUD_DATABASE_URL,
      snapshotSqlPath: process.env.TIER1_SNAPSHOT_SQL,
      tier1DatabaseUrl: process.env.DATABASE_URL_TIER1,
      tier1StorageUrl: process.env.TIER1_STORAGE_URL ?? 'http://127.0.0.1:54321',
      tier1ServiceRoleKey: process.env.TIER1_SERVICE_ROLE_KEY,
      userEmail: process.env.PLANNEN_USER_EMAIL,
      mcpBearerToken: process.env.MCP_BEARER_TOKEN,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      forceOverwrite: process.env.FORCE_OVERWRITE === '1',
      acceptStorageQuota: process.env.ACCEPT_STORAGE_QUOTA === '1',
    }
    const out = await run(ctx)
    process.stdout.write(`tier 2 migration complete (${out.doneSteps?.length ?? 0} steps)\n`)
  } catch (e) {
    process.stderr.write(`tier 2 migration failed: ${e.message}\n`)
    process.exit(1)
  }
}
