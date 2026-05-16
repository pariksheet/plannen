#!/usr/bin/env node
// Tier 2 health check. Runs after bootstrap.sh --tier 2 (or any time).
//
// Inputs (env or ctx): SUPABASE_PROJECT_REF, SUPABASE_URL, MCP_BEARER_TOKEN,
//   PLANNEN_USER_EMAIL, CLOUD_DATABASE_URL (optional, for row/photo counts).
//
// Checks:
//   1. cloud SUPABASE_URL reachable (auth health endpoint)
//   2. cloud /functions/v1/mcp tools/list with bearer returns ≥ 1 tool
//   3. plugin/.claude-plugin/plugin.json points at the cloud URL + has the bearer
//   4. (if CLOUD_DATABASE_URL): plannen.users row exists for PLANNEN_USER_EMAIL
//   5. (if CLOUD_DATABASE_URL + TIER1_DATABASE_URL): photo count parity
//
// Exits 0 on all-green, 1 on any failure. Each line is "✓"/"✗" prefixed.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin', '.claude-plugin', 'plugin.json')

// Pure: did the plugin manifest get rewritten to point at the cloud MCP?
export function checkPluginManifest(text, { cloudUrl, bearer }) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'plugin.json is not valid JSON' }
  }
  const entry = data?.mcpServers?.plannen
  if (!entry) return { ok: false, reason: 'no mcpServers.plannen entry' }
  if (entry.type !== 'http') {
    return { ok: false, reason: `mcpServers.plannen.type is "${entry.type}", expected "http"` }
  }
  const expectedUrl = `${cloudUrl.replace(/\/+$/, '')}/functions/v1/mcp`
  if (entry.url !== expectedUrl) {
    return { ok: false, reason: `url is "${entry.url}", expected "${expectedUrl}"` }
  }
  const auth = entry.headers?.Authorization ?? ''
  if (!auth.startsWith('Bearer ') || auth.slice('Bearer '.length) !== bearer) {
    return { ok: false, reason: 'Authorization header missing or does not match bearer' }
  }
  return { ok: true, reason: '' }
}

// Pure: parse a tools/list JSON-RPC response.
export function parseToolsListResponse(body) {
  if (!body || typeof body !== 'object') return { ok: false, count: 0, reason: 'no body' }
  if (body.error) return { ok: false, count: 0, reason: body.error.message ?? 'jsonrpc error' }
  const tools = body.result?.tools
  if (!Array.isArray(tools)) return { ok: false, count: 0, reason: 'result.tools missing' }
  return { ok: true, count: tools.length, reason: '' }
}

// IO: hit the cloud auth health endpoint. We use /auth/v1/health (returns 200
// + `{ name: 'GoTrue', ... }` on any project).
export async function checkSupabaseReachable(cloudUrl, { fetch = globalThis.fetch } = {}) {
  const url = `${cloudUrl.replace(/\/+$/, '')}/auth/v1/health`
  try {
    const res = await fetch(url)
    return { ok: res.ok, reason: res.ok ? '' : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

// IO: tools/list against the cloud MCP function.
export async function checkMcpTools(cloudUrl, bearer, { fetch = globalThis.fetch } = {}) {
  const url = `${cloudUrl.replace(/\/+$/, '')}/functions/v1/mcp`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    if (!res.ok) return { ok: false, count: 0, reason: `HTTP ${res.status}` }
    const body = await res.json()
    return parseToolsListResponse(body)
  } catch (e) {
    return { ok: false, count: 0, reason: e.message }
  }
}

// IO: does the plannen.users row exist for the given email?
export async function checkUserRow(
  { cloudDatabaseUrl, email },
  { Client = pg.Client } = {},
) {
  const client = new Client({ connectionString: cloudDatabaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM auth.users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    )
    return { ok: rows.length === 1, reason: rows.length === 1 ? '' : `no auth.users row for ${email}` }
  } finally {
    await client.end()
  }
}

// IO: storage.objects count on a connection.
export async function countPhotos(connectionString, { Client = pg.Client, bucket = 'event-photos' } = {}) {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1`,
      [bucket],
    )
    return rows[0].n
  } finally {
    await client.end()
  }
}

// Top-level: run all checks, print a summary, return overall pass/fail.
export async function run(ctx = {}, deps = {}) {
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`))
  const fetch = deps.fetch ?? globalThis.fetch
  const Client = deps.Client ?? pg.Client

  const lines = []
  let failed = 0
  const record = (ok, label, detail = '') => {
    const prefix = ok ? '✓' : '✗'
    lines.push(`${prefix} ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failed++
  }

  // 1. Supabase reachable.
  if (!ctx.cloudSupabaseUrl) {
    record(false, 'cloud Supabase URL configured', 'SUPABASE_URL not set')
  } else {
    const r = await checkSupabaseReachable(ctx.cloudSupabaseUrl, { fetch })
    record(r.ok, `cloud reachable at ${ctx.cloudSupabaseUrl}`, r.reason)
  }

  // 2. MCP tools/list.
  if (!ctx.cloudSupabaseUrl || !ctx.mcpBearerToken) {
    record(false, 'cloud MCP tools/list', 'cloudSupabaseUrl or MCP_BEARER_TOKEN missing')
  } else {
    const r = await checkMcpTools(ctx.cloudSupabaseUrl, ctx.mcpBearerToken, { fetch })
    record(r.ok, `cloud MCP tools/list`, r.ok ? `${r.count} tool(s)` : r.reason)
  }

  // 3. Plugin manifest points at cloud.
  const manifestPath = ctx.pluginManifestPath ?? PLUGIN_MANIFEST
  if (existsSync(manifestPath)) {
    const text = readFileSync(manifestPath, 'utf8')
    const r = checkPluginManifest(text, {
      cloudUrl: ctx.cloudSupabaseUrl ?? '',
      bearer: ctx.mcpBearerToken ?? '',
    })
    record(r.ok, 'plugin.json points at cloud MCP', r.reason)
  } else {
    record(false, 'plugin.json present', `not found at ${manifestPath}`)
  }

  // 4. User row.
  if (ctx.cloudDatabaseUrl && ctx.userEmail) {
    const r = await checkUserRow(
      { cloudDatabaseUrl: ctx.cloudDatabaseUrl, email: ctx.userEmail },
      { Client },
    )
    record(r.ok, `auth.users row for ${ctx.userEmail}`, r.reason)
  } else {
    record(true, 'auth.users row check', 'skipped (no cloudDatabaseUrl)')
  }

  // 5. Photo parity (optional).
  if (ctx.cloudDatabaseUrl && ctx.tier1DatabaseUrl) {
    try {
      const t1 = await countPhotos(ctx.tier1DatabaseUrl, { Client })
      const t2 = await countPhotos(ctx.cloudDatabaseUrl, { Client })
      record(t1 === t2, 'photo count parity', `tier1=${t1}, cloud=${t2}`)
    } catch (e) {
      record(false, 'photo count parity', e.message)
    }
  } else {
    record(true, 'photo count parity', 'skipped (no tier1DatabaseUrl)')
  }

  for (const l of lines) log(l)

  return { failed, lines }
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await run({
    cloudSupabaseUrl: process.env.SUPABASE_URL,
    mcpBearerToken: process.env.MCP_BEARER_TOKEN,
    userEmail: process.env.PLANNEN_USER_EMAIL,
    cloudDatabaseUrl: process.env.CLOUD_DATABASE_URL,
    tier1DatabaseUrl: process.env.TIER1_DATABASE_URL,
  })
  process.exit(out.failed === 0 ? 0 : 1)
}
