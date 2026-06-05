import { defineCommand } from 'citty';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeEnv,
  profileExists,
  resolveActiveProfile,
} from '../lib/profiles.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/**
 * Apply forward-only DB migrations for the active profile's tier.
 *
 * The heavy lifting lives in scripts/lib/migrate.mjs, which already dispatches
 * on PLANNEN_TIER:
 *   tier 0 → supabase/migrations-tier0/*.sql then supabase/migrations/*.sql via pg
 *   tier 1 → supabase/migrations/*.sql via pg
 *   tier 2 → `supabase db push --project-ref $SUPABASE_PROJECT_REF`
 *
 * This verb just resolves the profile and feeds it the composed env. It does
 * not generate new migrations — that's `supabase migration new`, dev-time only.
 */
export async function invokeMigrate(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const repoRoot = ctx.repoRoot ?? DEFAULT_REPO_ROOT;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const spawner = ctx.spawner ?? nodeSpawn;

  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  if (!profileName) {
    throw new Error('migrate: no active profile. Pass --profile=<name> or run `plannen init` first.');
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`migrate: profile '${profileName}' does not exist`);
  }

  const composed = composeEnv(profileName, {}, baseEnv);
  const tier = composed.PLANNEN_TIER ?? '0';

  log(`Applying migrations for profile '${profileName}' (Tier ${tier})…`);

  const scriptPath = path.join(repoRoot, 'scripts', 'lib', 'migrate.mjs');
  const child = spawner('node', [scriptPath], {
    stdio: 'inherit',
    env: { ...process.env, ...composed },
  });

  const code = await new Promise((resolve) => {
    child.on('exit', (c, signal) => {
      if (signal) {
        const sigNum = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1;
        resolve(128 + sigNum);
      } else {
        resolve(c ?? 1);
      }
    });
  });
  return code;
}

export const migrateCommand = defineCommand({
  meta: {
    name: 'migrate',
    description: "Apply forward-only DB migrations to the active profile's database",
  },
  args: {
    profile: { type: 'string', description: 'Profile to migrate (defaults to the active profile)' },
  },
  async run({ args }) {
    const code = await invokeMigrate(args);
    process.exit(code);
  },
});
