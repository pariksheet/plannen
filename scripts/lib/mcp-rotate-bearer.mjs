#!/usr/bin/env node
// Rotate MCP_BEARER_TOKEN: new random token → `supabase secrets set` →
// rewrite local .env + plugin/.claude-plugin/plugin.json. Caller (the shell
// wrapper) reads PLANNEN_TIER + SUPABASE_PROJECT_REF from .env first.
//
// Tier-2 only. On Tier 0/1 the MCP doesn't run in cloud, so rotation is a
// no-op — the wrapper short-circuits before calling this.
//
// All side effects are dep-injected so tests can drive the rotation without
// touching real files or the CLI.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { rewriteEnvContent, rewritePluginManifest } from './migrate-tier1-to-tier2.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

function defaultCli(args) {
  const r = spawnSync('supabase', args, { encoding: 'utf8' })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// Top-level rotation.
//
// ctx: {
//   projectRef       — required
//   cloudSupabaseUrl — required (preserved in plugin.json)
//   envPath          — defaults to <repo>/.env
//   pluginManifestPath — defaults to plugin manifest
// }
// deps: { cli, rng }
export async function rotate(ctx = {}, deps = {}) {
  if (!ctx.projectRef) throw new Error('rotate requires ctx.projectRef')
  if (!ctx.cloudSupabaseUrl) throw new Error('rotate requires ctx.cloudSupabaseUrl')
  const cli = deps.cli ?? defaultCli
  const rng = deps.rng ?? randomBytes
  const envPath = ctx.envPath ?? join(REPO_ROOT, '.env')
  const pluginPath =
    ctx.pluginManifestPath ?? join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

  const bearer = rng(32).toString('hex')

  // 1. Push to cloud secrets first; if that fails, don't touch local files.
  const args = ['secrets', 'set', '--project-ref', ctx.projectRef, `MCP_BEARER_TOKEN=${bearer}`]
  const r = cli(args)
  if (r.status !== 0) {
    throw new Error(`supabase secrets set failed: ${r.stderr || r.stdout}`)
  }

  // 2. Rewrite .env.
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, 'utf8')
    writeFileSync(envPath, rewriteEnvContent(text, { MCP_BEARER_TOKEN: bearer }))
  }

  // 3. Rewrite plugin.json.
  if (existsSync(pluginPath)) {
    const text = readFileSync(pluginPath, 'utf8')
    writeFileSync(
      pluginPath,
      rewritePluginManifest(text, { cloudUrl: ctx.cloudSupabaseUrl, bearer }),
    )
  }

  return { bearer, envPath, pluginPath }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const out = await rotate({
      projectRef: process.env.SUPABASE_PROJECT_REF,
      cloudSupabaseUrl: process.env.SUPABASE_URL,
    })
    process.stdout.write(
      `rotated. bearer (now in .env + plugin.json):\n  ${out.bearer}\n` +
        `Reload the plannen plugin in Claude Code to pick up the new token.\n`,
    )
  } catch (e) {
    process.stderr.write(`rotate failed: ${e.message}\n`)
    process.exit(1)
  }
}
