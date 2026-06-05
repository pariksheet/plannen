import { defineCommand } from 'citty';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeEnv,
  profileExists,
  resolveActiveProfile,
  setActive,
  swapEnvSymlink,
} from '../../lib/profiles.mjs';
import { isBackendRunning, isPgRunning } from '../../lib/lifecycle.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

export async function invokeProfileUse(rawArgs, ctx = {}) {
  const env = ctx.env ?? process.env;
  const repoRoot = ctx.repoRoot ?? DEFAULT_REPO_ROOT;
  // Truth for "previous profile still has services" is the Plannen PID files
  // (pg + backend), not a port probe — probes collide with anything else on
  // 54322 (Colima SSH multiplex, an unrelated Postgres, etc.) and falsely
  // refuse a valid profile switch. Probe with the PREVIOUS profile's composed
  // env so its per-profile pid paths are honoured (#7).
  const isUp = ctx.isProfileRunning
    ?? ((e) => isPgRunning(e) || isBackendRunning(e));
  const swap = ctx.swap ?? swapEnvSymlink;

  const name = rawArgs.name;
  if (!name) throw new Error('profile use: <name> is required');
  if (!profileExists(name, env)) throw new Error(`profile use: '${name}' does not exist`);

  const prev = resolveActiveProfile(env);
  if (prev && prev !== name && profileExists(prev, env)) {
    if (isUp(composeEnv(prev, {}, env))) {
      throw new Error(
        `profile use: previous profile '${prev}' is still running. ` +
        `Run \`plannen down\` first.`,
      );
    }
  }

  setActive(name, env);
  swap(name, repoRoot, env);
  return 0;
}

export const profileUseCommand = defineCommand({
  meta: { name: 'use', description: 'Switch the active profile' },
  args: {
    name: { type: 'positional', description: 'Profile name', required: true },
  },
  async run({ args }) {
    await invokeProfileUse(args);
    process.stdout.write(`active profile: ${args.name}\n`);
    process.exit(0);
  },
});
