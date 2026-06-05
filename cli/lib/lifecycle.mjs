import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Path to the embedded-Postgres PID file. scripts/lib/plannen-pg.mjs writes
 * it on start and removes it on stop. Existence + a live PID is the canonical
 * "Plannen is running" signal.
 */
export function getPgPidFile(env = process.env) {
  const home = env.HOME ?? homedir();
  return join(home, '.plannen', 'pg.pid');
}

/**
 * True if the embedded Postgres process Plannen launched is still alive.
 *
 * We deliberately do NOT probe the PG port to answer this — port probes
 * collide with anything else listening on 54322 (Colima SSH multiplex,
 * a different Postgres install, an SSH tunnel, etc.). The PID file is the
 * only thing Plannen actually owns; if it isn't there, we don't own the port.
 */
export function isPgRunning(env = process.env) {
  const pidFile = getPgPidFile(env);
  if (!existsSync(pidFile)) return false;
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 doesn't kill — it just probes whether the PID exists.
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH (no such process) or EPERM both mean "not our running process".
    return false;
  }
}
