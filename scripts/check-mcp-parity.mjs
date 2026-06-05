#!/usr/bin/env node
// Guard against MCP tool drift between the two server implementations (#15).
//
// CLAUDE.md mandates every tool exists in BOTH servers:
//   - mcp/src/index.ts            (local stdio server, Tier 0)
//   - supabase/functions/mcp/     (HTTP edge function, Tier 1/2 — what Claude
//                                  Code actually talks to in cloud modes)
// A tool present in only one silently 404s on the other side. The only
// sanctioned exceptions live in LOCAL_ONLY below, each with a justification.
//
// Usage: node scripts/check-mcp-parity.mjs   (exit 1 on unlisted drift)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tools that intentionally exist ONLY in the local stdio server. Every entry
 * needs a reason — "forgot to mirror it" is not one. Remove entries that get
 * mirrored later; the checker errors on stale entries.
 */
export const LOCAL_ONLY = {
  transcribe_memory:
    'spawns a host-side whisper.cpp binary (whisper-cli on PATH) — impossible in a Deno edge function',
};

/** Extract tool names declared as `name: 'tool_name',` on their own line. */
export function extractToolNames(sourceText) {
  const names = [];
  const re = /^\s+name: '([a-z_0-9]+)',\s*$/gm;
  let m;
  while ((m = re.exec(sourceText)) !== null) names.push(m[1]);
  return [...new Set(names)].sort();
}

export function collectLocalTools(repoRoot = REPO_ROOT) {
  return extractToolNames(readFileSync(path.join(repoRoot, 'mcp/src/index.ts'), 'utf8'));
}

export function collectCloudTools(repoRoot = REPO_ROOT) {
  const toolsDir = path.join(repoRoot, 'supabase/functions/mcp/tools');
  const names = [];
  for (const f of readdirSync(toolsDir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    names.push(...extractToolNames(readFileSync(path.join(toolsDir, f), 'utf8')));
  }
  return [...new Set(names)].sort();
}

/**
 * Diff the two tool sets against the allowlist.
 * @returns {{localOnly: string[], cloudOnly: string[], staleAllowlist: string[], ok: boolean}}
 */
export function diffTools(local, cloud, localOnlyAllowlist = LOCAL_ONLY) {
  const cloudSet = new Set(cloud);
  const localSet = new Set(local);
  const allowed = new Set(Object.keys(localOnlyAllowlist));
  const localOnly = local.filter((t) => !cloudSet.has(t) && !allowed.has(t));
  const cloudOnly = cloud.filter((t) => !localSet.has(t));
  // Allowlist hygiene: entries that are no longer local-only (mirrored or
  // deleted) must be removed so the list stays honest.
  const staleAllowlist = [...allowed].filter((t) => !localSet.has(t) || cloudSet.has(t));
  return { localOnly, cloudOnly, staleAllowlist, ok: !localOnly.length && !cloudOnly.length && !staleAllowlist.length };
}

function main() {
  const local = collectLocalTools();
  const cloud = collectCloudTools();
  const { localOnly, cloudOnly, staleAllowlist, ok } = diffTools(local, cloud);

  console.log(`local stdio tools: ${local.length}  cloud edge tools: ${cloud.length}  allowlisted local-only: ${Object.keys(LOCAL_ONLY).length}`);
  if (localOnly.length) {
    console.error(`\n✗ tools missing from the CLOUD edge function (add a ToolModule under supabase/functions/mcp/tools/ and register it in index.ts, or allowlist with a justification):`);
    for (const t of localOnly) console.error(`  - ${t}`);
  }
  if (cloudOnly.length) {
    console.error(`\n✗ tools missing from the LOCAL stdio server (register in mcp/src/index.ts):`);
    for (const t of cloudOnly) console.error(`  - ${t}`);
  }
  if (staleAllowlist.length) {
    console.error(`\n✗ stale LOCAL_ONLY allowlist entries (tool was mirrored or removed — delete the entry):`);
    for (const t of staleAllowlist) console.error(`  - ${t}`);
  }
  if (!ok) process.exit(1);
  console.log('✓ MCP tool parity holds');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
