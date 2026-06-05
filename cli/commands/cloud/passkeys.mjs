import { defineCommand } from 'citty';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeEnv,
  profileExists,
  readManifest,
} from '../../lib/profiles.mjs';
import * as supabaseMgmt from '../../../scripts/lib/supabase-mgmt.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

// Derive a WebAuthn RP ID from a URL. RP IDs must be a registrable domain or
// a subdomain of one, and they're effectively immutable once users start
// registering passkeys, so we apply only the most conservative normalisation:
//   - strip protocol + path
//   - strip `www.` if present
//   - leave everything else alone (callers can override via --rp-id)
//
// `localhost` and bare IPs pass through unchanged — WebAuthn permits localhost
// as an RP ID for development.
export function deriveRpId(urlString) {
  let host;
  try {
    host = new URL(urlString).hostname.toLowerCase();
  } catch {
    throw new Error(`cannot derive RP ID from invalid URL: ${urlString}`);
  }
  if (!host) throw new Error(`URL has no hostname: ${urlString}`);
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

// Derive WebAuthn origins from a primary URL. Always includes the canonical
// origin (protocol + host + optional port). Callers can pass extras for
// e.g. `https://www.<rp>` aliases.
export function deriveOrigins(urlString, extras = []) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`cannot derive origins from invalid URL: ${urlString}`);
  }
  const canonical = `${url.protocol}//${url.host}`;
  const out = [canonical];
  for (const extra of extras) {
    const e = String(extra).trim().replace(/\/+$/, '');
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Enable passkeys on a Supabase Cloud project.
 *
 * args = { profile: string, rpId?: string, origins?: string[], displayName?: string }
 * ctx = { env?, repoRoot?, log?, supabaseMgmt? }
 *
 * Refuses on non-cloud_sb profiles. Reads PLANNEN_WEB_URL from the profile
 * env unless the caller passes rpId + origins explicitly. Idempotent —
 * mgmt.updatePasskeyConfig returns { changed: false } when current state
 * already matches.
 */
export async function invokePasskeysEnable(args, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const repoRoot = ctx.repoRoot ?? DEFAULT_REPO_ROOT;
  void repoRoot;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const mgmt = ctx.supabaseMgmt ?? supabaseMgmt;

  const profileName = args.profile;
  if (!profileName) {
    throw new Error('cloud passkeys enable: --profile <name> is required');
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`cloud passkeys enable: profile '${profileName}' does not exist`);
  }
  const manifest = readManifest(profileName, baseEnv);
  if (manifest.mode !== 'cloud_sb') {
    throw new Error(
      `cloud passkeys enable: profile '${profileName}' has mode=${manifest.mode}; cloud_sb required`,
    );
  }

  const env = composeEnv(profileName, {}, baseEnv);
  const projectRef = env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    throw new Error(
      `cloud passkeys enable: profile '${profileName}' has no SUPABASE_PROJECT_REF; ` +
      `run \`plannen cloud provision --profile ${profileName}\` first`,
    );
  }
  const webUrl = env.PLANNEN_WEB_URL;
  const rpId = args.rpId || (webUrl ? deriveRpId(webUrl) : null);
  if (!rpId) {
    throw new Error(
      `cloud passkeys enable: no PLANNEN_WEB_URL in profile and no --rp-id given; ` +
      `pass --rp-id explicitly or deploy first so the URL is recorded`,
    );
  }
  const origins = args.origins && args.origins.length
    ? args.origins
    : webUrl
      ? deriveOrigins(webUrl)
      : [`https://${rpId}`];
  const displayName = args.displayName || 'Plannen';

  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    throw new Error(
      'cloud passkeys enable: no Supabase access token found. Run `supabase login` ' +
      '(or set SUPABASE_ACCESS_TOKEN).',
    );
  }

  log(`==> enabling passkeys on '${profileName}' (ref ${projectRef})`);
  log(`  rp_id:       ${rpId}`);
  log(`  origins:     ${origins.join(', ')}`);
  log(`  display:     ${displayName}`);
  log('');
  log('  ⚠  RP ID is effectively immutable once users register passkeys.');
  log('     Changing it later orphans every existing credential.');

  const result = await mgmt.updatePasskeyConfig(token, projectRef, {
    rpId,
    rpOrigins: origins,
    rpDisplayName: displayName,
  });

  log(`==> ${result.changed ? 'updated' : 'already up to date'}`);
  log('');
  log('  Next: flip the frontend feature flag so the UI actually appears:');
  log(`    vercel env add VITE_PASSKEYS_ENABLED production   # value: true`);
  log(`    npx plannen deploy --profile ${profileName}`);
  return { rpId, origins, displayName, changed: result.changed };
}

const enableCommand = defineCommand({
  meta: {
    name: 'enable',
    description: 'Enable Supabase passkey/WebAuthn config on a cloud_sb profile',
  },
  args: {
    profile: { type: 'string', description: 'Profile to enable passkeys on', required: true },
    'rp-id': {
      type: 'string',
      description: 'WebAuthn relying-party ID (defaults to host of PLANNEN_WEB_URL with www. stripped)',
    },
    origins: {
      type: 'string',
      description: 'Comma-separated WebAuthn origins (defaults to canonical PLANNEN_WEB_URL origin)',
    },
    'display-name': {
      type: 'string',
      description: 'Display name shown in the browser passkey prompt',
    },
  },
  async run({ args }) {
    const parsedOrigins = args.origins
      ? String(args.origins).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    await invokePasskeysEnable(
      {
        profile: args.profile,
        rpId: args['rp-id'],
        origins: parsedOrigins,
        displayName: args['display-name'],
      },
      {},
    );
    process.exit(0);
  },
});

export const passkeysCommand = defineCommand({
  meta: { name: 'passkeys', description: 'Passkey/WebAuthn configuration on cloud profiles' },
  subCommands: { enable: enableCommand },
});
