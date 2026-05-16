#!/usr/bin/env node
// Phase B.2 — Vercel deploy.
//
// Pushes the web app's Tier 2 .env vars into the linked Vercel project and
// kicks off a production deploy. Re-runnable: existing env vars are removed
// + re-added so values stay current.
//
// Inputs (ctx):
//   ctx.envText      — contents of repo .env (so the orchestrator is pure)
//   ctx.target       — 'production' | 'preview' | 'development' (default 'production')
//   ctx.prod         — bool; whether to deploy with --prod (default true)
//
// Outputs (added to ctx):
//   pushedKeys       — string[] of env var names that were pushed
//   deploymentUrl    — parsed from `vercel` stdout
//
// All CLI invocations are dep-injected so tests can stub them.

import { spawn, spawnSync } from 'node:child_process'

// Pure: parse a .env file body and pull out the keys we ship to Vercel.
// Anything beginning with `VITE_` is what Vite bakes into the bundle.
export function pickEnvForVercel(envText) {
  const out = {}
  const lines = envText.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2]
    // Strip optional matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!key.startsWith('VITE_')) continue
    if (value === '') continue
    out[key] = value
  }
  return out
}

// Pure: extract the production URL Vercel prints. Handles a few formats:
//   "Production: https://x.vercel.app [..]"
//   "https://x-abc.vercel.app"
//   "✅  Production: https://x.vercel.app"
export function parseDeployUrl(stdout) {
  if (!stdout) return null
  const prodMatch = stdout.match(/Production:\s*(https?:\/\/[^\s\[\]]+)/i)
  if (prodMatch) return prodMatch[1]
  const anyUrl = stdout.match(/(https?:\/\/[a-z0-9-]+\.vercel\.app[^\s]*)/i)
  if (anyUrl) return anyUrl[1]
  return null
}

// Default sync CLI runner (status + stdout + stderr).
function defaultCli(args, opts = {}) {
  const r = spawnSync('vercel', args, {
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

// Default async CLI runner that streams stdin to the subprocess. Used for
// `vercel env add` which reads the value from stdin.
function defaultCliWithStdin(args, input) {
  return new Promise((resolve) => {
    const proc = spawn('vercel', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdoutChunks = []
    const stderrChunks = []
    proc.stdout.on('data', (c) => stdoutChunks.push(c))
    proc.stderr.on('data', (c) => stderrChunks.push(c))
    proc.on('close', (code) =>
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }),
    )
    proc.stdin.end(input)
  })
}

// IO: is `vercel login` authed?
export function vercelLoggedIn({ cli = defaultCli } = {}) {
  return cli(['whoami']).status === 0
}

// IO: remove an existing env var. Returns true if removed, false if not found.
export function vercelEnvRm(name, target, { cli = defaultCli } = {}) {
  const r = cli(['env', 'rm', name, target, '--yes'])
  return r.status === 0
}

// IO: add an env var. Value is fed via stdin (non-interactive).
export async function vercelEnvAdd(
  name,
  value,
  target,
  { cli = defaultCliWithStdin } = {},
) {
  const r = await cli(['env', 'add', name, target], value)
  if (r.status !== 0) {
    throw new Error(`vercel env add ${name} ${target} → exit ${r.status}: ${r.stderr || r.stdout}`)
  }
}

// IO: deploy. Returns { url, raw }.
export function vercelDeploy({ prod = true } = {}, { cli = defaultCli } = {}) {
  const args = prod ? ['--prod'] : []
  const r = cli(args)
  if (r.status !== 0) {
    throw new Error(`vercel deploy → exit ${r.status}: ${r.stderr || r.stdout}`)
  }
  const url = parseDeployUrl(r.stdout) ?? parseDeployUrl(r.stderr)
  return { url, raw: r.stdout }
}

// Top-level orchestrator.
export async function run(ctx = {}, deps = {}) {
  const cli = deps.cli ?? defaultCli
  const cliWithStdin = deps.cliWithStdin ?? defaultCliWithStdin
  const log = deps.log ?? ((s) => process.stderr.write(`${s}\n`))

  if (!ctx.envText) throw new Error('vercel-deploy requires ctx.envText (string)')
  const target = ctx.target ?? 'production'

  if (!vercelLoggedIn({ cli })) {
    throw new Error('vercel CLI is not logged in — run `vercel login` first')
  }

  const envMap = pickEnvForVercel(ctx.envText)
  const keys = Object.keys(envMap)
  if (keys.length === 0) {
    throw new Error('no VITE_* keys found in envText — Tier 2 bootstrap not run?')
  }

  log(`  pushing ${keys.length} env var(s) to vercel (${target}): ${keys.join(', ')}`)
  for (const key of keys) {
    // Best-effort remove (no-op if not set), then add.
    vercelEnvRm(key, target, { cli })
    await vercelEnvAdd(key, envMap[key], target, { cli: cliWithStdin })
  }

  log(`  deploying${ctx.prod === false ? '' : ' --prod'}`)
  const { url } = vercelDeploy({ prod: ctx.prod !== false }, { cli })

  return { ...ctx, pushedKeys: keys, deploymentUrl: url }
}

// CLI entry: reads .env from repo root.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs')
  const { dirname, resolve, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const REPO_ROOT = resolve(HERE, '../..')
  try {
    const envText = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    const out = await run({ envText })
    process.stdout.write(
      `deployed: ${out.deploymentUrl ?? '(URL not parsed — check stdout above)'}\n` +
        `pushed ${out.pushedKeys.length} env var(s)\n`,
    )
  } catch (e) {
    process.stderr.write(`vercel-deploy failed: ${e.message}\n`)
    process.exit(1)
  }
}
