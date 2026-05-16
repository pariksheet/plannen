#!/usr/bin/env node
// Tier 1 → Tier 2 migration orchestrator.
//
// Runs the eight steps in the spec at
// docs/superpowers/specs/2026-05-16-tier-2-cloud-deploy-design.md:
//
//   1. snapshot Tier 1 (delegates to scripts/lib/snapshot.mjs)
//   2. link cloud (cloud-link.mjs)
//   3. push schema (supabase db push)
//   4. restore data into cloud DB (psql against cloud DATABASE_URL)
//   5. upload photos (storage-cloud-upload.mjs)
//   6. deploy functions + set secrets (cloud-deploy.mjs)
//   7. rewrite local .env + plugin.json (backs up first)
//   8. verify (delegates to cloud-doctor.mjs once that's wired in)
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
} from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import * as cloudLink from './cloud-link.mjs'
import * as cloudDeploy from './cloud-deploy.mjs'
import * as storageUpload from './storage-cloud-upload.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const DEFAULT_PROGRESS_PATH = join(REPO_ROOT, '.plannen-tier2-progress')

// Step names. Order matters for resume.
export const STEPS = [
  'snapshot',
  'link',
  'push-schema',
  'restore-data',
  'upload-photos',
  'deploy',
  'rewrite-config',
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

// IO: spawn `supabase db push`.
function defaultPushSchema(projectRef) {
  return spawnSync(
    'supabase',
    ['db', 'push', '--project-ref', projectRef, '--linked'],
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
  const done = readProgress(progressPath)
  const pending = pendingSteps(STEPS, done)

  if (pending.length === 0) {
    log('  all steps already completed (delete .plannen-tier2-progress to re-run)')
    return { ...ctx, doneSteps: [...done] }
  }

  let cur = { ...ctx }

  for (const step of pending) {
    log(`▸ step: ${step}`)
    switch (step) {
      case 'snapshot':
        await stepSnapshot(cur, deps)
        break
      case 'link':
        cur = await stepLink(cur, deps)
        break
      case 'push-schema':
        await stepPushSchema(cur, deps)
        break
      case 'restore-data':
        await stepRestoreData(cur, deps)
        break
      case 'upload-photos':
        cur = await stepUploadPhotos(cur, deps)
        break
      case 'deploy':
        cur = await stepDeploy(cur, deps)
        break
      case 'rewrite-config':
        await stepRewriteConfig(cur, deps)
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
  if (ctx.skipSnapshot) return
  const runSnapshot = deps.runSnapshot ?? defaultRunSnapshot
  const out = ctx.snapshotDir ?? join(REPO_ROOT, '.plannen', 'snapshots')
  mkdirSync(out, { recursive: true })
  const r = runSnapshot(['--tier', '1', '--out', out, '--keep', '5'])
  if (r.status !== 0) throw new Error(`snapshot failed (exit ${r.status})`)
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

async function stepRestoreData(ctx, deps) {
  if (!ctx.cloudDatabaseUrl) {
    throw new Error(
      'restore-data requires ctx.cloudDatabaseUrl (full pg URL with password); ' +
        `hint: ${cloudDbUrlHint(ctx.projectRef ?? '<ref>')}`,
    )
  }
  if (!ctx.snapshotSqlPath) {
    throw new Error('restore-data requires ctx.snapshotSqlPath')
  }
  const sqlText = readFileSync(ctx.snapshotSqlPath, 'utf8')
  const restore = deps.restoreData ?? defaultRestoreData
  await restore({
    cloudDatabaseUrl: ctx.cloudDatabaseUrl,
    sqlText,
    forceOverwrite: ctx.forceOverwrite === true,
    ClientCtor: deps.Client,
  })
}

async function stepUploadPhotos(ctx, deps) {
  return storageUpload.run(ctx, deps)
}

async function stepDeploy(ctx, deps) {
  return cloudDeploy.run(ctx, deps)
}

async function stepRewriteConfig(ctx, deps) {
  if (!ctx.projectRef) throw new Error('rewrite-config requires ctx.projectRef')
  if (!ctx.mcpBearerToken) throw new Error('rewrite-config requires ctx.mcpBearerToken')
  if (!ctx.cloudSupabaseUrl) throw new Error('rewrite-config requires ctx.cloudSupabaseUrl')
  if (!ctx.cloudAnonKey) throw new Error('rewrite-config requires ctx.cloudAnonKey')

  const envPath = ctx.envPath ?? join(REPO_ROOT, '.env')
  const pluginPath =
    ctx.pluginManifestPath ?? join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

  // Back up first (Tier 1 → 2 only; fresh installs may not have these).
  if (existsSync(envPath) && !existsSync(`${envPath}.tier1.bak`)) {
    copyFileSync(envPath, `${envPath}.tier1.bak`)
  }
  if (existsSync(pluginPath) && !existsSync(`${pluginPath}.tier1.bak`)) {
    copyFileSync(pluginPath, `${pluginPath}.tier1.bak`)
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
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  if (!res.ok) {
    throw new Error(`verify: cloud MCP returned HTTP ${res.status}`)
  }
  const body = await res.json()
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
