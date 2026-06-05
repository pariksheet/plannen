#!/usr/bin/env node
// Tier 2 step: link the local repo to a Supabase Cloud project and pull the
// cloud anon + service-role API keys. Pure helpers are unit-testable; the
// `run(ctx)` orchestrator wires them with the real `supabase` CLI.
//
// Inputs (ctx or env):
//   ctx.projectRef             — required (or env SUPABASE_PROJECT_REF)
// Outputs (added to ctx):
//   projectRef
//   cloudSupabaseUrl           — https://<ref>.supabase.co
//   cloudAnonKey
//   cloudServiceRoleKey
//
// All CLI invocations go through a `cli` dep so tests can stub them.

import { spawnSync } from 'node:child_process'

// Pure: project ref is a short slug. The Supabase CLI will reject anything
// truly malformed; we just guard against empty / obviously-wrong values.
export function validateProjectRef(ref) {
  if (typeof ref !== 'string') return false
  return /^[a-z0-9]{15,32}$/.test(ref)
}

// Pure: parse `supabase projects api-keys --output json` output into the
// keys we care about. Throws if the expected entries are missing.
export function parseApiKeys(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  if (!Array.isArray(data)) {
    throw new Error('expected array from `supabase projects api-keys`')
  }
  const pick = (name) => {
    const row = data.find((r) => r && r.name === name)
    if (!row) throw new Error(`no '${name}' key in api-keys response`)
    return row.api_key
  }
  return {
    anonKey: pick('anon'),
    serviceRoleKey: pick('service_role'),
  }
}

// Pure: build the canonical cloud URL for a project.
export function cloudUrlFor(projectRef) {
  if (!validateProjectRef(projectRef)) {
    throw new Error(`invalid project ref: ${projectRef}`)
  }
  return `https://${projectRef}.supabase.co`
}

// Default CLI runner. Tests substitute their own via `deps.cli`.
function defaultCli(args, { input } = {}) {
  const r = spawnSync('supabase', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

function requireOk(result, args) {
  if (result.status !== 0) {
    throw new Error(
      `supabase ${args.join(' ')} → exit ${result.status}: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

// IO: returns true if a `supabase login` session exists.
export function isLoggedIn({ cli = defaultCli } = {}) {
  const r = cli(['projects', 'list'])
  return r.status === 0
}

// IO: link the cwd to the given cloud project. Idempotent — re-linking is OK.
export function linkProject(projectRef, { cli = defaultCli } = {}) {
  if (!validateProjectRef(projectRef)) {
    throw new Error(`invalid project ref: ${projectRef}`)
  }
  const args = ['link', '--project-ref', projectRef]
  requireOk(cli(args), args)
}

// IO: fetch cloud API keys for a linked project.
export function fetchApiKeys(projectRef, { cli = defaultCli } = {}) {
  const args = ['projects', 'api-keys', '--project-ref', projectRef, '--output', 'json']
  const stdout = requireOk(cli(args), args)
  return parseApiKeys(stdout)
}

// Top-level orchestrator. Pure functional shape: takes a ctx, returns a new
// ctx with the cloud-link fields populated.
export async function run(ctx = {}, deps = {}) {
  const cli = deps.cli ?? defaultCli
  if (!isLoggedIn({ cli })) {
    throw new Error('supabase CLI is not logged in — run `supabase login` first')
  }
  const projectRef = ctx.projectRef || process.env.SUPABASE_PROJECT_REF
  if (!projectRef) {
    throw new Error(
      'SUPABASE_PROJECT_REF not set; pass ctx.projectRef or export the env var',
    )
  }
  if (!validateProjectRef(projectRef)) {
    throw new Error(`invalid project ref format: ${projectRef}`)
  }
  linkProject(projectRef, { cli })
  const { anonKey, serviceRoleKey } = fetchApiKeys(projectRef, { cli })
  return {
    ...ctx,
    projectRef,
    cloudSupabaseUrl: cloudUrlFor(projectRef),
    cloudAnonKey: anonKey,
    cloudServiceRoleKey: serviceRoleKey,
  }
}

// CLI entry: useful for one-off debugging. Not used by bootstrap directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const ctx = await run({})
    process.stdout.write(
      `linked ${ctx.projectRef}\n` +
        `  url:          ${ctx.cloudSupabaseUrl}\n` +
        `  anon key:     ${ctx.cloudAnonKey.slice(0, 8)}…\n` +
        `  service role: ${ctx.cloudServiceRoleKey.slice(0, 8)}…\n`,
    )
  } catch (e) {
    process.stderr.write(`cloud-link failed: ${e.message}\n`)
    process.exit(1)
  }
}
