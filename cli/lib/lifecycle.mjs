import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Path to the embedded-Postgres PID file. scripts/lib/plannen-pg.mjs writes
 * it on start and removes it on stop. Existence + a live PID is the canonical
 * "Plannen is running" signal.
 */
export function getPgPidFile(env = process.env) {
  if (env.PLANNEN_PG_PID) return env.PLANNEN_PG_PID;
  const home = env.HOME ?? homedir();
  return join(home, '.plannen', 'pg.pid');
}

/** Backend pid file — per-profile when seeded (#7), legacy global otherwise. */
export function getBackendPidFile(env = process.env) {
  if (env.PLANNEN_BACKEND_PID) return env.PLANNEN_BACKEND_PID;
  const home = env.HOME ?? homedir();
  return join(home, '.plannen', 'backend.pid');
}

/**
 * Returns the full command string for the given PID, or '' if it can't be
 * determined (process gone, permission denied, ps not available, etc.).
 * Used as a default for the injectable `pidCommand` param in the checkers below.
 */
function defaultPidCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * True if the pid recorded in `pidFile` is alive AND its command line contains
 * `marker`.  The `pidCommand` param is injectable for tests (defaults to the
 * real `ps` lookup).
 *
 * Returning false when the command is empty/unknown is intentional — it is
 * safer to under-report "running" than to falsely block a profile switch
 * because an unrelated process recycled the PID.
 */
function pidFileAlive(pidFile, marker, pidCommand = defaultPidCommand) {
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Fast-path: if the PID is completely gone, skip the ps call.
    process.kill(pid, 0);
  } catch {
    // ESRCH (no such process) or EPERM both mean "not our running process".
    return false;
  }
  // Identity check: verify the command line contains our known marker so that
  // OS PID-reuse cannot cause a false positive (#fix-B).
  const cmd = pidCommand(pid);
  return cmd.includes(marker);
}

/**
 * True if the Plannen backend this env owns is still alive.
 *
 * Marker: `backend/dist/index.js` — the path fragment that appears in the
 * `nohup node <...>/backend/dist/index.js` command spawned by backend-start.sh.
 *
 * @param {object} env - Environment object (defaults to process.env).
 * @param {function} [_pidCommand] - Injectable ps resolver for tests.
 */
export function isBackendRunning(env = process.env, _pidCommand = defaultPidCommand) {
  return pidFileAlive(getBackendPidFile(env), 'backend/dist/index.js', _pidCommand);
}

/**
 * True if the embedded Postgres process Plannen launched is still alive.
 *
 * We deliberately do NOT probe the PG port to answer this — port probes
 * collide with anything else listening on 54322 (Colima SSH multiplex,
 * a different Postgres install, an SSH tunnel, etc.). The PID file is the
 * only thing Plannen actually owns; if it isn't there, we don't own the port.
 *
 * Marker: `plannen-pg.mjs` — the script name that appears in the node command
 * written by scripts/lib/plannen-pg.mjs when it spawns (it is the running
 * script itself, so `process.argv[1]` contains this name).
 *
 * @param {object} env - Environment object (defaults to process.env).
 * @param {function} [_pidCommand] - Injectable ps resolver for tests.
 */
export function isPgRunning(env = process.env, _pidCommand = defaultPidCommand) {
  return pidFileAlive(getPgPidFile(env), 'plannen-pg.mjs', _pidCommand);
}
