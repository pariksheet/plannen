#!/usr/bin/env node
// Drift guard for the duplicated pure scheduling/recurrence engine.
//
// The recurrence + scheduling logic is intentionally copied across three runtimes
// because none can import the others (Tier 0 Node, Deno edge, Vite web — separate
// tsconfigs/build graphs):
//
//   mcp/src/practices.ts                       (canonical: occursOn + practice due/period logic)
//   supabase/functions/_shared/practices.ts    (Deno mirror)
//   mcp/src/scheduling.ts                       (canonical: attendance/obligation engine)
//   supabase/functions/_shared/scheduling.ts    (Deno mirror)
//   src/utils/scheduling.ts                     (web mirror — a SUPERSET: it also copies
//                                                occursOn + helpers, and adds web-only projectDay)
//
// This script extracts every top-level `function`/`const` declaration from these
// files and asserts that any symbol appearing in 2+ of them is byte-identical
// across all of them. Web-only symbols (e.g. projectDay) appear once → not checked.
// Imports, type aliases, and comments are ignored — only declaration bodies matter.
//
// Run in CI and via `npm run test:cli`. Exits non-zero on any drift.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = [
  'mcp/src/practices.ts',
  'supabase/functions/_shared/practices.ts',
  'mcp/src/scheduling.ts',
  'supabase/functions/_shared/scheduling.ts',
  'src/utils/scheduling.ts',
]

// A line that closes a top-level block (column 0): `}`, `} as const`, `]`, `] as const`.
const CLOSER = /^(}|]|\) =>|};?|}\s+as\s+const|]\s+as\s+const);?$/

function balanced(line) {
  const opens = (line.match(/[[{(]/g) ?? []).length
  const closes = (line.match(/[\]})]/g) ?? []).length
  return opens === closes
}

/**
 * Extract top-level `function NAME(...)` and `const NAME = ...` declarations.
 * Returns Map<name, text> with trailing whitespace stripped per line.
 * A declaration runs from its opening line to the first column-0 closer line
 * (for multi-line bodies/literals), or ends on its own line if already balanced.
 */
function extractDecls(absPath) {
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const decls = new Map()
  const declRe = /^(?:export\s+)?(?:function|const)\s+([A-Za-z0-9_]+)\b/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(declRe)
    if (!m) continue
    const name = m[1]
    const isFn = /^(?:export\s+)?function\b/.test(lines[i])
    const block = [lines[i]]
    // A single-line balanced const (e.g. `const X = [...] as const`) ends immediately.
    const singleLine = !isFn && balanced(lines[i])
    if (!singleLine) {
      for (let j = i + 1; j < lines.length; j++) {
        block.push(lines[j])
        if (CLOSER.test(lines[j])) { i = j; break }
      }
    }
    decls.set(name, block.map((l) => l.replace(/\s+$/, '')).join('\n'))
  }
  return decls
}

const perFile = new Map()
for (const rel of FILES) {
  try {
    perFile.set(rel, extractDecls(join(repoRoot, rel)))
  } catch (err) {
    console.error(`✗ cannot read ${rel}: ${err.message}`)
    process.exit(2)
  }
}

const bySymbol = new Map() // name -> [{file, text}]
for (const [file, decls] of perFile) {
  for (const [name, text] of decls) {
    if (!bySymbol.has(name)) bySymbol.set(name, [])
    bySymbol.get(name).push({ file, text })
  }
}

const drift = []
const shared = []
for (const [name, occ] of bySymbol) {
  if (occ.length < 2) continue // web-only / canonical-only — nothing to compare
  shared.push(name)
  const ref = occ[0]
  const mismatches = occ.slice(1).filter((o) => o.text !== ref.text)
  if (mismatches.length) drift.push({ name, ref, mismatches })
}

if (drift.length) {
  console.error('✗ engine drift detected — these shared symbols are NOT byte-identical across mirrors:\n')
  for (const d of drift) {
    console.error(`  • ${d.name}`)
    console.error(`      ref:     ${d.ref.file}`)
    for (const mm of d.mismatches) console.error(`      DRIFTED: ${mm.file}`)
  }
  console.error('\nFix: re-sync the drifted copies to the canonical body (mcp/src is canonical).')
  process.exit(1)
}

console.log(`✓ engine parity holds — ${shared.length} shared symbol(s) byte-identical across mirror files:`)
console.log(`  ${shared.sort().join(', ')}`)
