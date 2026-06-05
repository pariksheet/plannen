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
import * as supabaseMgmtDefault from './supabase-mgmt.mjs'

// Replace or append a `KEY=value` line in an .env body. Returns the new text.
// Preserves surrounding lines and trailing newline.
export function upsertEnvKey(envText, key, value) {
  const line = `${key}=${value}`
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm')
  if (re.test(envText)) return envText.replace(re, line)
  return envText.endsWith('\n') ? `${envText}${line}\n` : `${envText}\n${line}\n`
}

// Pull a single key out of an .env body. (pickEnvForVercel filters to VITE_* only.)
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

// Parse a .env file body and pull out the keys we ship to Vercel.
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

// Vercel prints the URL in several formats — match the labelled "Production:"
// line first, otherwise fall back to any .vercel.app URL. URL characters stop
// at whitespace and at common shell/JSON terminators (`"`, `'`, `,`, `[`,
// `]`, `<`, `>`) so a quoted/json-wrapped output doesn't leak punctuation
// into the captured URL.
export function parseDeployUrl(stdout) {
  if (!stdout) return null
  const prodMatch = stdout.match(/Production:\s*(https?:\/\/[^\s"',\[\]<>]+)/i)
  if (prodMatch) return prodMatch[1]
  const anyUrl = stdout.match(/(https?:\/\/[a-z0-9-]+\.vercel\.app[^\s"',\[\]<>]*)/i)
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

export function vercelLoggedIn({ cli = defaultCli } = {}) {
  return cli(['whoami']).status === 0
}

// Auto-links a project when .vercel/ is missing. Falls back to instructing
// manual `vercel link` if the cwd dir name conflicts with an existing project
// the team owns.
export function vercelLink({ yes = true } = {}, { cli = defaultCli } = {}) {
  const args = ['link']
  if (yes) args.push('--yes')
  const r = cli(args)
  if (r.status !== 0) {
    throw new Error(`vercel link → exit ${r.status}: ${r.stderr || r.stdout}`)
  }
  return r
}

export function vercelEnvRm(name, target, { cli = defaultCli } = {}) {
  const r = cli(['env', 'rm', name, target, '--yes'])
  return r.status === 0
}

// Value fed via stdin so the call is non-interactive.
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

export function vercelDeploy({ prod = true } = {}, { cli = defaultCli } = {}) {
  const args = prod ? ['--prod'] : []
  const r = cli(args)
  if (r.status !== 0) {
    throw new Error(`vercel deploy → exit ${r.status}: ${r.stderr || r.stdout}`)
  }
  const url = parseDeployUrl(r.stdout) ?? parseDeployUrl(r.stderr)
  return { url, raw: r.stdout }
}

// Pulls the lines under `Aliases` from `vercel inspect <url>` stdout.
export function parseInspectAliases(stdout) {
  if (!stdout) return []
  const lines = stdout.split('\n')
  const startIdx = lines.findIndex((l) => /^\s*Aliases\b/.test(l))
  if (startIdx < 0) return []
  const out = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line) && out.length > 0) break
    const m = line.match(/(https?:\/\/[a-z0-9.-]+\.vercel\.app[^\s"',\[\]<>]*)/i)
    if (m) out.push(m[1])
  }
  return out
}

// Pick the most stable alias from `vercel inspect` output. Stable = not a
// per-deployment hash URL (those look like `plannen-<hash>-<team>.vercel.app`).
// We prefer the shortest hostname, since `<name>.vercel.app` is shorter than
// the `<name>-<team>.vercel.app` fallback Vercel hands out when the bare name
// is taken.
export function findStableAlias(aliases, deployUrl) {
  if (!aliases || aliases.length === 0) return null
  const deployHost = deployUrl ? new URL(deployUrl).hostname : ''
  const candidates = aliases
    .map((u) => ({ url: u, host: new URL(u).hostname }))
    .filter((c) => c.host !== deployHost)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.host.length - b.host.length)
  return candidates[0].url
}

export function vercelInspect(url, { cli = defaultCli } = {}) {
  const r = cli(['inspect', url])
  // `vercel inspect` writes everything to stderr in current CLI versions; some
  // older versions used stdout. Read both.
  const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  return parseInspectAliases(combined)
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

  // Resolve the stable production alias (e.g. plannen.vercel.app) when possible.
  // We prefer it over the per-deployment URL for both the Supabase Site URL
  // and the value written back to .env — otherwise every deploy churns those
  // and breaks magic-link emails against prior deployments.
  let stableUrl = null
  if (url) {
    const aliases = vercelInspect(url, { cli })
    stableUrl = findStableAlias(aliases, url)
    if (stableUrl && stableUrl !== url) {
      log(`  resolved stable alias: ${stableUrl}`)
    }
  }
  const primaryUrl = stableUrl ?? url

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
    // Best-effort: the deploy has already succeeded. Don't abort the return
    // value if the Management API rejects (token expired, API outage, etc.).
    try {
      // Per-deployment URLs (plannen-<hash>-<scope>.vercel.app) accumulate in
      // the allow-list forever — Supabase eventually rejects it as too large.
      // Prune prior ones for this project; the current one is re-added below.
      // The stable alias (plannen.vercel.app) doesn't match the pattern.
      let pruneAllowList
      if (stableUrl) {
        const project = new URL(stableUrl).hostname.split('.')[0]
        const esc = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        pruneAllowList = new RegExp(`^https://${esc}-[a-z0-9]+-[^.]+\\.vercel\\.app(/\\*\\*)?$`)
      }
      await mgmt.updateAuthConfig(token, projectRef, {
        siteUrl: primaryUrl,
        addAllowList: [
          `${primaryUrl.replace(/\/+$/, '')}/**`,
          `${url.replace(/\/+$/, '')}/**`,
        ],
        pruneAllowList,
      })
      log(`  post-deploy auth wire: ✓ site_url=${primaryUrl}`)
    } catch (e) {
      log(`  post-deploy auth wire: ⚠ failed — ${e instanceof Error ? e.message : String(e)} (set Site URL by hand in the Supabase dashboard)`)
    }
  }

  return { ...ctx, pushedKeys: keys, deploymentUrl: url, stableUrl, primaryUrl }
}

// CLI entry: reads .env from repo root.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { dirname, resolve, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const REPO_ROOT = resolve(HERE, '../..')
  const envPath = join(REPO_ROOT, '.env')
  try {
    const envText = readFileSync(envPath, 'utf8')
    const out = await run({ envText })
    process.stdout.write(
      `deployed: ${out.deploymentUrl ?? '(URL not parsed — check stdout above)'}\n` +
        `pushed ${out.pushedKeys.length} env var(s)\n`,
    )
    if (out.primaryUrl) {
      writeFileSync(envPath, upsertEnvKey(envText, 'PLANNEN_WEB_URL', out.primaryUrl))
      process.stdout.write(`wrote PLANNEN_WEB_URL=${out.primaryUrl} to .env\n`)
    }
  } catch (e) {
    process.stderr.write(`vercel-deploy failed: ${e.message}\n`)
    process.exit(1)
  }
}
