import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import {
  VALID_MODES,
  getProfileEnvPath,
  modeToTier,
  nextPortOffset,
  parseEnvText,
  portsFor,
  profileExists,
  readEnvFile,
  readEnvSymlinkTarget,
  resolveActiveProfile,
  setActive,
  swapEnvSymlink,
  writeEnvFile,
  writeManifest,
} from './profiles.mjs';

/**
 * Make sure a profile named `name` exists, the active pointer is set to it,
 * and <repoRoot>/.env is a symlink to its env file. Migrates any pre-existing
 * regular `.env` file into the profile's env file and backs the original up
 * to `.env.legacy-backup`.
 *
 * Idempotent: running it on already-migrated state is a no-op.
 *
 * @returns {{created: boolean, migratedKeys: string[], backedUp: boolean}}
 */
export function ensureProfile({ name = 'default', mode = 'local_pg', env = process.env, repoRoot, now = () => new Date().toISOString() } = {}) {
  if (!repoRoot) throw new Error('ensureProfile: repoRoot is required');
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`ensureProfile: mode must be one of ${VALID_MODES.join(', ')}`);
  }
  const repoEnv = path.join(repoRoot, '.env');
  const repoEnvStat = lstatOrNull(repoEnv);

  if (profileExists(name, env)) {
    // Profile already exists. Just ensure the .env symlink is in place.
    return ensureSymlink(name, repoRoot, repoEnv, repoEnvStat, env);
  }

  // Profile doesn't exist — create it. Migrate the regular .env file into it.
  const migratedVars =
    repoEnvStat && !repoEnvStat.isSymbolicLink()
      ? parseEnvText(readFileSync(repoEnv, 'utf8'))
      : {};
  const portOffset = nextPortOffset(env);
  writeManifest(
    name,
    { name, mode, port_offset: portOffset, created_at: now() },
    env,
  );
  // PLANNEN_PROFILE intentionally NOT seeded — composeEnv injects it at
  // runtime; storing it would leak through dotenv into other shells.
  const seed = {
    ...migratedVars,
    PLANNEN_TIER: modeToTier(mode),
    ...portsFor(mode, portOffset),
  };
  delete seed.PLANNEN_PROFILE;
  writeEnvFile(getProfileEnvPath(name, env), seed);

  const backedUp = backupRegularEnv(repoEnv, repoEnvStat);
  swapEnvSymlink(name, repoRoot, env);
  if (!resolveActiveProfile(env)) {
    setActive(name, env);
  }
  return {
    created: true,
    migratedKeys: Object.keys(migratedVars),
    backedUp,
  };
}

function ensureSymlink(name, repoRoot, repoEnv, repoEnvStat, env) {
  const currentTarget = readEnvSymlinkTarget(repoRoot);
  const desired = getProfileEnvPath(name, env);
  if (currentTarget === desired) {
    if (!resolveActiveProfile(env)) setActive(name, env);
    return { created: false, migratedKeys: [], backedUp: false };
  }
  let backedUp = false;
  if (repoEnvStat && !repoEnvStat.isSymbolicLink()) {
    // Regular file lying next to an already-existing profile — merge contents
    // in, then back up.
    const existingProfileEnv = readEnvFile(getProfileEnvPath(name, env));
    const legacyVars = parseEnvText(readFileSync(repoEnv, 'utf8'));
    writeEnvFile(getProfileEnvPath(name, env), { ...existingProfileEnv, ...legacyVars });
    backedUp = backupRegularEnv(repoEnv, repoEnvStat);
  }
  swapEnvSymlink(name, repoRoot, env);
  if (!resolveActiveProfile(env)) setActive(name, env);
  return { created: false, migratedKeys: [], backedUp };
}

function backupRegularEnv(repoEnv, st) {
  if (!st || st.isSymbolicLink()) return false;
  const backup = `${repoEnv}.legacy-backup`;
  renameSync(repoEnv, backup);
  return true;
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}
