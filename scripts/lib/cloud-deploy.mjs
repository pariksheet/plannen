#!/usr/bin/env node
// Tier 2 step: deploy all Supabase Edge Functions to the linked cloud
// project and set the function-side secrets they read.
//
// The MCP function is deployed with `--no-verify-jwt` because it owns its
// own bearer-token auth (see supabase/functions/mcp/index.ts). All other
// functions keep Supabase's default JWT verification.
//
// Inputs (ctx):
//   ctx.projectRef             — required
//   ctx.mcpBearerToken         — optional; generated if absent
//   ctx.userEmail              — PLANNEN_USER_EMAIL on the function side
//   ctx.googleClientId         — optional
//   ctx.googleClientSecret     — optional
//   ctx.anthropicApiKey        — optional (per-user BYOK lives in DB; this
//                                only exists if the user wants a project-
//                                level fallback for cron functions)
//   ctx.extraSecrets           — { KEY: value } map merged into the set call
// Outputs (added to ctx):
//   mcpBearerToken             — generated if it wasn't present
//   deployedFunctions          — string[] of function names successfully deployed
//
// All CLI invocations go through a `cli` dep so tests can stub them.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const FUNCTIONS_DIR = join(REPO_ROOT, 'supabase', 'functions')

// Pure: generate a 64-char hex token (32 random bytes).
export function generateBearer(rng = randomBytes) {
  return rng(32).toString('hex')
}

// Pure: list deployable edge-function directory names.
// Skips internal scaffolding (`_shared`), test fixtures, and node_modules.
// Pass `dir` to test against a fixture tree.
export function discoverFunctions(dir = FUNCTIONS_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => {
      if (name.startsWith('_')) return false
      if (name.startsWith('.')) return false
      if (name === 'node_modules') return false
      if (name === 'package.json' || name === 'package-lock.json') return false
      if (name === 'vitest.config.ts') return false
      const sub = join(dir, name)
      try {
        if (!statSync(sub).isDirectory()) return false
      } catch {
        return false
      }
      // Require an index.ts entrypoint to consider it deployable.
      return existsSync(join(sub, 'index.ts'))
    })
    .sort()
}

// Pure: deploy order — MCP first so a deploy failure stops the run before
// the rest of the stack rewires itself to a broken function.
export function orderFunctionsForDeploy(names) {
  const out = [...names].sort()
  const mcpIdx = out.indexOf('mcp')
  if (mcpIdx > 0) {
    out.splice(mcpIdx, 1)
    out.unshift('mcp')
  }
  return out
}

// Pure: build the secrets KEY=VALUE pairs from a ctx-shaped object.
// Returns an array of `KEY=VALUE` strings (already shell-safe — no spaces
// in values is the caller's contract, since we're not shelling out).
export function buildSecretPairs(ctx) {
  const pairs = []
  const add = (k, v) => {
    if (v == null || v === '') return
    pairs.push(`${k}=${v}`)
  }
  add('PLANNEN_USER_EMAIL', ctx.userEmail)
  add('MCP_BEARER_TOKEN', ctx.mcpBearerToken)
  add('GOOGLE_CLIENT_ID', ctx.googleClientId)
  add('GOOGLE_CLIENT_SECRET', ctx.googleClientSecret)
  add('ANTHROPIC_API_KEY', ctx.anthropicApiKey)
  if (ctx.extraSecrets && typeof ctx.extraSecrets === 'object') {
    for (const [k, v] of Object.entries(ctx.extraSecrets)) add(k, v)
  }
  return pairs
}

// Default CLI runner. Tests substitute via `deps.cli`.
function defaultCli(args, opts = {}) {
  const r = spawnSync('supabase', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
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

// IO: deploy a single function. mcp gets --no-verify-jwt.
export function deployFunction(name, projectRef, { cli = defaultCli } = {}) {
  const args = ['functions', 'deploy', name, '--project-ref', projectRef]
  if (name === 'mcp') args.push('--no-verify-jwt')
  requireOk(cli(args), args)
}

// IO: set all function-side secrets in one CLI call.
export function setSecrets(pairs, projectRef, { cli = defaultCli } = {}) {
  if (pairs.length === 0) return
  const args = ['secrets', 'set', '--project-ref', projectRef, ...pairs]
  requireOk(cli(args), args)
}

// Top-level orchestrator.
export async function run(ctx = {}, deps = {}) {
  if (!ctx.projectRef) throw new Error('cloud-deploy requires ctx.projectRef')
  const cli = deps.cli ?? defaultCli
  const functionsDir = deps.functionsDir ?? FUNCTIONS_DIR

  // 1. Bearer
  const bearer = ctx.mcpBearerToken || generateBearer(deps.rng)
  const next = { ...ctx, mcpBearerToken: bearer }

  // 2. Secrets — set them BEFORE deploy so the first invocation sees them.
  setSecrets(buildSecretPairs(next), ctx.projectRef, { cli })

  // 3. Deploy — mcp first; on failure, abort before touching the rest.
  const discovered = discoverFunctions(functionsDir)
  const order = orderFunctionsForDeploy(discovered)
  const deployed = []
  for (const name of order) {
    deployFunction(name, ctx.projectRef, { cli })
    deployed.push(name)
  }

  return { ...next, deployedFunctions: deployed }
}

// CLI entry: useful for re-deploying secrets + functions after a code change.
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectRef = process.env.SUPABASE_PROJECT_REF
  if (!projectRef) {
    process.stderr.write('SUPABASE_PROJECT_REF required\n')
    process.exit(1)
  }
  try {
    const out = await run({
      projectRef,
      userEmail: process.env.PLANNEN_USER_EMAIL,
      mcpBearerToken: process.env.MCP_BEARER_TOKEN,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    })
    process.stdout.write(
      `deployed ${out.deployedFunctions.length} function(s): ${out.deployedFunctions.join(', ')}\n`,
    )
    if (!process.env.MCP_BEARER_TOKEN) {
      process.stdout.write(`bearer (save this — only shown once):\n  ${out.mcpBearerToken}\n`)
    }
  } catch (e) {
    process.stderr.write(`cloud-deploy failed: ${e.message}\n`)
    process.exit(1)
  }
}
