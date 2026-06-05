import { defineCommand } from 'citty';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScript } from '../lib/runScript.mjs';
import {
  composeEnv,
  profileExists,
  resolveActiveProfile,
} from '../lib/profiles.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

/**
 * Snapshot the active profile's database + photos.
 *
 * Delegates to scripts/export-seed.sh, which already dispatches on
 * PLANNEN_TIER:
 *   tier 0 → node table dumper against embedded pg + tar ~/.plannen/photos
 *   tier 1 → docker exec pg_dump + docker exec tar /mnt
 *   tier 2 → node table dumper against $CLOUD_DATABASE_URL + cloud-photos dumper
 *
 * Output paths are fixed (supabase/seed.sql + supabase/seed-photos.tar.gz)
 * because the Tier-0 install flow auto-restores from those paths on a fresh
 * ~/.plannen/pgdata. Copy elsewhere after the run if you want timestamped
 * archives.
 *
 * Tier 2 needs CLOUD_DATABASE_URL set in the profile env (the script prints a
 * helpful error if missing). VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 * also required for photo download and come from `plannen cloud provision`.
 */
export async function invokeBackup(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const run = ctx.runScript ?? runScript;
  const spawner = ctx.spawner;

  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  if (!profileName) {
    throw new Error('backup: no active profile. Pass --profile=<name> or run `plannen init` first.');
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`backup: profile '${profileName}' does not exist`);
  }

  const composed = composeEnv(profileName, {}, baseEnv);
  const tier = composed.PLANNEN_TIER ?? '0';

  log(`Backing up profile '${profileName}' (Tier ${tier})…`);
  return await run({
    script: 'scripts/export-seed.sh',
    env: composed,
    spawner,
  });
}

export const backupCommand = defineCommand({
  meta: {
    name: 'backup',
    description: "Snapshot the active profile's database + photos to supabase/seed.sql + seed-photos.tar.gz",
  },
  args: {
    profile: { type: 'string', description: 'Profile to back up (defaults to the active profile)' },
  },
  async run({ args }) {
    const code = await invokeBackup(args);
    process.exit(code);
  },
});

// Re-export for parity with deploy.mjs; keeps the import surface uniform.
export { DEFAULT_REPO_ROOT };
