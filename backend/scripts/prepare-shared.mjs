#!/usr/bin/env node
// Stages a Node-compatible copy of the Deno-source `_shared/` directory
// into `backend/src/_shared/` so tsc, tsx, and vitest can resolve it
// alongside the rest of the backend source tree.
//
// Idempotent: safe to run on every `npm run dev`, `npm test`, or build.
//
// The directory it produces is gitignored — only the originals under
// `supabase/functions/_shared/` are committed.
//
// Node-only overlay: files at `backend/src/_shared-overlay/` are copied on
// TOP of the Deno staging (after rewrites), letting Node-only modules
// (e.g. providers/claude-cli.ts, providers/run-cli.ts, cliDetection.ts)
// live alongside the staged Deno modules. Overlay files keep `.test.ts`
// extensions intact and are NOT rewritten — they are already Node-native.

import { existsSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = resolve(here, '..')
const repoRoot = resolve(backendRoot, '..')
const sharedSrc = join(repoRoot, 'supabase', 'functions', '_shared')
const sharedDst = join(backendRoot, 'src', '_shared')
const overlaySrc = join(backendRoot, 'src', '_shared-overlay')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function rewriteFile(path) {
  const src = readFileSync(path, 'utf8')
  let out = src
    // npm:@scope/pkg@version  →  @scope/pkg     (preserves any /subpath)
    .replace(/(['"])npm:(@[^/]+\/[^@'"]+)@[^/'"]+(\/[^'"]+)?\1/g, '$1$2$3$1')
    // npm:pkg@version  →  pkg
    .replace(/(['"])npm:([^@/'"]+)@[^/'"]+(\/[^'"]+)?\1/g, '$1$2$3$1')
    // Relative `.ts` imports → `.js` so NodeNext module resolution can
    // pick up tsc's compiled output (or tsx's in-memory transform).
    .replace(/(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
  if (out !== src) writeFileSync(path, out)
}

if (existsSync(sharedDst)) rmSync(sharedDst, { recursive: true, force: true })
cpSync(sharedSrc, sharedDst, { recursive: true })

// Drop the test-only mock helper directory before walking files.
const testlibDir = join(sharedDst, 'handlers', '_testlib')
if (existsSync(testlibDir)) rmSync(testlibDir, { recursive: true, force: true })

// Drop the Deno-only entries (`db.ts` and `jwt.ts`) — these are imported
// by `supabase/functions/<name>/index.ts` and rely on `Deno.env`. Node
// ships its own pg pool + user-context helper in `backend/src/db.ts`.
for (const denoOnly of ['db.ts', 'jwt.ts']) {
  const p = join(sharedDst, denoOnly)
  if (existsSync(p)) rmSync(p, { force: true })
}

for (const file of walk(sharedDst)) {
  if (file.endsWith('.test.ts')) {
    // Drop staged tests — they live in their own vitest project and
    // shouldn't be type-checked or compiled as part of the backend.
    rmSync(file, { force: true })
    continue
  }
  // Also drop the test-only mock helper to keep the staged tree lean.
  if (file.includes('/_testlib/') || file.includes('\\_testlib\\')) {
    rmSync(file, { force: true })
    continue
  }
  if (file.endsWith('.ts')) rewriteFile(file)
}

// Overlay Node-only modules on top of the staged Deno tree. These files
// are Node-native (real `node:child_process`, `pg.Pool`, etc.) so they
// must NOT pass through `rewriteFile`. They DO ship test files because
// vitest runs them straight out of `backend/src/_shared/`.
if (existsSync(overlaySrc)) {
  cpSync(overlaySrc, sharedDst, { recursive: true })
}
