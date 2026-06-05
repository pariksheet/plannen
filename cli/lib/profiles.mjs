import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  readlinkSync,
} from 'node:fs';
import path from 'node:path';

export const VALID_MODES = ['local_pg', 'local_sb', 'cloud_sb'];
const PORT_STEP = 100;

/**
 * CI / synthetic-profile mode. When `PLANNEN_PROFILE_FROM_ENV=1` is set,
 * profile resolution skips `~/.plannen/profiles/` entirely and reads
 * everything from `process.env`. The `--profile <name>` arg becomes a label
 * for log lines. Same code paths local users hit; CI just feeds different
 * inputs — no CI-specific branching inside the verbs themselves.
 */
export function isSyntheticMode(env = process.env) {
  return env.PLANNEN_PROFILE_FROM_ENV === '1';
}

function syntheticManifest(name, env) {
  const tier = env.PLANNEN_TIER ?? '0';
  const mode = { '0': 'local_pg', '1': 'local_sb', '2': 'cloud_sb' }[tier] ?? 'local_pg';
  return { name, mode, port_offset: 0, created_at: null, synthetic: true };
}

function home(env) {
  // Only the explicit env.HOME is honoured — no fallback to process.env.HOME
  // when env was passed in. This keeps tests that pass synthetic envs from
  // leaking onto the real ~/.plannen.
  return env.HOME ?? '';
}

export function getPlannenHome(env = process.env) {
  if (env.PLANNEN_HOME) return env.PLANNEN_HOME;
  return path.join(home(env), '.plannen');
}

export function getProfilesDir(env = process.env) {
  return path.join(getPlannenHome(env), 'profiles');
}

export function getProfileDir(name, env = process.env) {
  return path.join(getProfilesDir(env), name);
}

export function getProfileManifestPath(name, env = process.env) {
  return path.join(getProfileDir(name, env), 'profile.json');
}

export function getProfileEnvPath(name, env = process.env) {
  return path.join(getProfileDir(name, env), 'env');
}

export function getActivePointerPath(env = process.env) {
  return path.join(getPlannenHome(env), 'active');
}

export function profileExists(name, env = process.env) {
  if (isSyntheticMode(env)) return true;
  return existsSync(getProfileManifestPath(name, env));
}

export function readManifest(name, env = process.env) {
  if (isSyntheticMode(env)) return syntheticManifest(name, env);
  const p = getProfileManifestPath(name, env);
  if (!existsSync(p)) throw new Error(`profile not found: ${name} (${p})`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeManifest(name, manifest, env = process.env) {
  const dir = getProfileDir(name, env);
  mkdirSync(dir, { recursive: true });
  const p = getProfileManifestPath(name, env);
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export function listProfiles(env = process.env) {
  const dir = getProfilesDir(env);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out = [];
  for (const name of names) {
    const p = getProfileManifestPath(name, env);
    if (!existsSync(p)) continue;
    try {
      out.push(JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      // ignore malformed manifests; surface elsewhere if needed
    }
  }
  return out;
}

/**
 * Parse env-file text. Supports `KEY=VALUE`, surrounding "/' quotes, `#` line
 * comments, and blank lines. Lines without `=` are silently dropped. Values
 * are NOT recursively expanded — by design; profile envs are static.
 */
export function parseEnvText(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(p) {
  if (!existsSync(p)) return {};
  return parseEnvText(readFileSync(p, 'utf8'));
}

/**
 * Serialize a vars object back to KEY=VALUE lines. Values that contain
 * whitespace or quotes get double-quoted (with `"` escaped). Writes 0600.
 */
export function writeEnvFile(p, vars) {
  mkdirSync(path.dirname(p), { recursive: true });
  const lines = Object.entries(vars).map(([k, v]) => {
    const needsQuote = /[\s"']/.test(String(v));
    if (!needsQuote) return `${k}=${v}`;
    const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${k}="${escaped}"`;
  });
  writeFileSync(p, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  // Re-chmod in case fs honoured umask on creation.
  chmodSync(p, 0o600);
}

export function resolveActiveProfile(env = process.env) {
  if (env.PLANNEN_PROFILE) return env.PLANNEN_PROFILE;
  if (isSyntheticMode(env)) return 'synthetic';
  const p = getActivePointerPath(env);
  if (!existsSync(p)) return null;
  const v = readFileSync(p, 'utf8').trim();
  return v || null;
}

export function setActive(name, env = process.env) {
  const p = getActivePointerPath(env);
  if (name == null) {
    if (existsSync(p)) rmSync(p);
    return;
  }
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${name}\n`, 'utf8');
}

export function nextPortOffset(env = process.env) {
  const used = new Set(listProfiles(env).map((m) => Number(m.port_offset)).filter((n) => Number.isFinite(n)));
  let candidate = 0;
  while (used.has(candidate)) candidate += PORT_STEP;
  return candidate;
}

/**
 * Layered env composition:
 *   1. baseEnv (process.env in real use)
 *   2. profile env file
 *   3. CLI-injected: PLANNEN_PROFILE, PLANNEN_PROFILE_DIR
 *   4. caller overrides
 *
 * In synthetic mode (PLANNEN_PROFILE_FROM_ENV=1) the profile-env-file layer is
 * skipped and PLANNEN_PROFILE_DIR isn't injected — values come straight from
 * baseEnv.
 */
export function composeEnv(name, overrides = {}, baseEnv = process.env) {
  if (isSyntheticMode(baseEnv)) {
    return {
      ...baseEnv,
      PLANNEN_PROFILE: name,
      ...overrides,
    };
  }
  const profileEnv = readEnvFile(getProfileEnvPath(name, baseEnv));
  return {
    ...baseEnv,
    ...profileEnv,
    PLANNEN_PROFILE: name,
    PLANNEN_PROFILE_DIR: getProfileDir(name, baseEnv),
    ...overrides,
  };
}

/**
 * Port set for a (mode, offset) pair. Used by `profile create` to seed the
 * env file and by callers that need to know "where will this profile listen?".
 */
export function portsFor(mode, portOffset) {
  const o = Number(portOffset) || 0;
  if (mode === 'local_pg') {
    return {
      PLANNEN_PG_PORT: String(54322 + o),
      PLANNEN_BACKEND_PORT: String(54323 + o),
      PLANNEN_WEB_PORT: String(4321 + o),
    };
  }
  if (mode === 'local_sb') {
    return {
      PLANNEN_SUPABASE_API_PORT: String(54321 + o),
      PLANNEN_PG_PORT: String(54322 + o),
      PLANNEN_SUPABASE_STUDIO_PORT: String(54324 + o),
      PLANNEN_WEB_PORT: String(4321 + o),
    };
  }
  // cloud_sb — only the local web dev port matters.
  return { PLANNEN_WEB_PORT: String(4321 + o) };
}

/**
 * Return the default PLANNEN_STORAGE_BACKEND env var for a given mode and
 * optional explicit storage choice. Tier 0 (`local_pg`) is always `local-fs`.
 * Tier 1/2 default to `supabase`; `--storage s3` forces `s3` on Tier 1/2.
 * Combining `--storage s3` with `local_pg` is refused with a clear error.
 */
export function storageBackendDefaultsForMode(mode, storageChoice) {
  // storageChoice may be 'local-fs' | 'supabase' | 's3' | undefined.
  if (storageChoice === 's3' && mode === 'local_pg') {
    throw new Error(
      "profile create: --storage=s3 is not allowed with --mode=local_pg.\n" +
      "Tier 0 is single-user local mode and keeps photos under ~/.plannen/photos.\n" +
      "Use --mode=local_sb or --mode=cloud_sb for an S3-backed deployment.",
    );
  }
  if (mode === 'local_pg') return { PLANNEN_STORAGE_BACKEND: 'local-fs' };
  if (storageChoice === 's3') return { PLANNEN_STORAGE_BACKEND: 's3' };
  return { PLANNEN_STORAGE_BACKEND: 'supabase' };
}

export function modeToTier(mode) {
  return { local_pg: '0', local_sb: '1', cloud_sb: '2' }[mode];
}

export function tierToMode(tier) {
  return { '0': 'local_pg', '1': 'local_sb', '2': 'cloud_sb' }[String(tier)];
}

/**
 * Reconcile a profile's manifest.mode with the truth in its env file's
 * PLANNEN_TIER. Bootstrap and the tier-migrator write PLANNEN_TIER to the
 * env file but historically did not update the manifest, leading to drift
 * (issue #23).
 *
 * Returns `{ changed, before, after, reason }`. Synthetic mode is a no-op.
 * Missing profile / missing PLANNEN_TIER / unknown tier are no-ops too —
 * the function never throws on benign mismatches, so callers can invoke it
 * defensively from bootstrap step 7 even when the profile system isn't
 * fully engaged.
 */
export function syncManifestMode({ name, env = process.env } = {}) {
  if (!name) return { changed: false, reason: 'no-name' };
  if (isSyntheticMode(env)) return { changed: false, reason: 'synthetic' };
  if (!profileExists(name, env)) return { changed: false, reason: 'no-profile' };

  const envVars = readEnvFile(getProfileEnvPath(name, env));
  const tier = envVars.PLANNEN_TIER;
  if (tier == null || tier === '') return { changed: false, reason: 'no-tier' };
  const expected = tierToMode(tier);
  if (!expected) return { changed: false, reason: 'unknown-tier', tier };

  const manifest = readManifest(name, env);
  if (manifest.mode === expected) {
    return { changed: false, reason: 'in-sync', before: manifest.mode, after: manifest.mode };
  }
  const before = manifest.mode;
  const next = { ...manifest, mode: expected };
  writeManifest(name, next, env);
  return { changed: true, reason: 'updated', before, after: expected };
}

/**
 * Inverse: report drift without writing. Used by `plannen profile list`
 * to flag mismatched rows. Returns null when there's no drift.
 */
export function detectModeDrift({ name, env = process.env } = {}) {
  if (!name) return null;
  if (isSyntheticMode(env)) return null;
  if (!profileExists(name, env)) return null;
  const envVars = readEnvFile(getProfileEnvPath(name, env));
  const tier = envVars.PLANNEN_TIER;
  if (tier == null || tier === '') return null;
  const expected = tierToMode(tier);
  if (!expected) return null;
  const manifest = readManifest(name, env);
  if (manifest.mode === expected) return null;
  return { manifest_mode: manifest.mode, env_tier: tier, expected_mode: expected };
}

function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * Atomically point <repoRoot>/.env at the named profile's env file via symlink.
 * Caller is responsible for migrating an existing regular file (see env-symlink
 * migration in PR2-3). Refuses if .env exists as a regular file — the migration
 * path must run first.
 */
export function swapEnvSymlink(profileName, repoRoot, env = process.env) {
  const repoEnv = path.join(repoRoot, '.env');
  const target = getProfileEnvPath(profileName, env);
  const st = lstatOrNull(repoEnv);
  if (st && !st.isSymbolicLink()) {
    throw new Error(
      `swapEnvSymlink: ${repoEnv} exists as a regular file. Migrate it into a profile first.`,
    );
  }
  const tmp = `${repoEnv}.tmp-${process.pid}-${Date.now()}`;
  symlinkSync(target, tmp);
  renameSync(tmp, repoEnv);
}

export function readEnvSymlinkTarget(repoRoot) {
  const repoEnv = path.join(repoRoot, '.env');
  const st = lstatOrNull(repoEnv);
  if (!st || !st.isSymbolicLink()) return null;
  return readlinkSync(repoEnv);
}
