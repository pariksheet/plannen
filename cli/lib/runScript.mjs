import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/**
 * Spawn `bash <repo>/<script>` with merged env. Resolves with the exit code.
 * Inherits stdio so child output reaches the user terminal directly.
 *
 * @param {object} opts
 * @param {string} opts.script   Path relative to repo root, e.g. 'scripts/start.sh'.
 * @param {string[]} [opts.args] Arguments passed to the script.
 * @param {Record<string,string>} [opts.env] Extra env vars merged onto process.env.
 * @param {Function} [opts.spawner] Override for tests; defaults to node:child_process spawn.
 * @returns {Promise<number>} Exit code (0 = success).
 */
export function runScript({ script, args = [], env = {}, spawner = nodeSpawn } = {}) {
  const absScript = path.isAbsolute(script) ? script : path.join(REPO_ROOT, script);
  const childEnv = { ...process.env, ...env };
  const child = spawner('bash', [absScript, ...args], {
    stdio: 'inherit',
    env: childEnv,
  });
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) {
        // POSIX convention: signal-terminated processes exit with 128 + signal number.
        const sigNum = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1;
        resolve(128 + sigNum);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
