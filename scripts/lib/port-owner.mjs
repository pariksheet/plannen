// Identify which process holds a TCP listen port (#14).
//
// Tier 0 ports are easy to squat: a local Supabase Docker stack publishes
// 54321-54326, and on macOS those forwards surface as `ssh` (colima) or
// `com.docker.backend` (Docker Desktop) — so a foreign listener can answer
// connects meant for the embedded Postgres and produce confusing failures
// (e.g. nondeterministic 28P01 during migrations). Callers use this to fail
// fast with the owner's name instead.

import { spawnSync } from 'node:child_process';

/**
 * @returns {{pid: number, command: string} | null} the listener on `port`,
 * or null when the port is free or lsof is unavailable (best-effort).
 */
export function portOwner(port, sspawn = spawnSync) {
  const r = sspawn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  // -F machine format: lines like `p<pid>` and `c<command>`.
  const pid = r.stdout.match(/^p(\d+)$/m)?.[1];
  const command = r.stdout.match(/^c(.+)$/m)?.[1];
  if (!pid) return null;
  return { pid: Number(pid), command: command ?? 'unknown' };
}

/** One-line, actionable description of a squatted port. */
export function describePortSquatter(port, owner) {
  let hint = '';
  if (owner.command === 'ssh' || /docker/i.test(owner.command)) {
    hint = ' — likely a colima/Docker port-forward (a local Supabase stack publishes this port)';
  } else if (/postgres/i.test(owner.command)) {
    hint = " — possibly an orphaned embedded Postgres; try 'npx plannen down' first";
  }
  return `port ${port} is already held by ${owner.command} (pid ${owner.pid})${hint}. ` +
    `Stop it or use a profile with a different port offset.`;
}
