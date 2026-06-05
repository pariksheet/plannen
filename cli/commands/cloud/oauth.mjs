import { defineCommand } from 'citty';
import {
  composeEnv,
  profileExists,
  readManifest,
} from '../../lib/profiles.mjs';
import * as supabaseMgmt from '../../../scripts/lib/supabase-mgmt.mjs';

export const CONSENT_PATH = '/oauth/consent';

function resolveCloudProfile(verb, args, baseEnv) {
  const profileName = args.profile;
  if (!profileName) {
    throw new Error(`cloud oauth ${verb}: --profile <name> is required`);
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`cloud oauth ${verb}: profile '${profileName}' does not exist`);
  }
  const manifest = readManifest(profileName, baseEnv);
  if (manifest.mode !== 'cloud_sb') {
    throw new Error(
      `cloud oauth ${verb}: profile '${profileName}' has mode=${manifest.mode}; cloud_sb required`,
    );
  }
  const env = composeEnv(profileName, {}, baseEnv);
  const projectRef = env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    throw new Error(
      `cloud oauth ${verb}: profile '${profileName}' has no SUPABASE_PROJECT_REF; ` +
      `run \`plannen cloud provision --profile ${profileName}\` first`,
    );
  }
  return { profileName, env, projectRef };
}

/**
 * Enable the Supabase OAuth 2.1 server so the MCP edge function can be
 * registered as a claude.ai custom connector.
 *
 * args = { profile: string }
 * ctx = { env?, log?, supabaseMgmt? }
 *
 * Idempotent — mgmt.updateOAuthServerConfig is a no-op when current state
 * already matches.
 */
export async function invokeOauthEnable(args, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const mgmt = ctx.supabaseMgmt ?? supabaseMgmt;

  const { profileName, env, projectRef } = resolveCloudProfile('enable', args, baseEnv);

  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    throw new Error(
      'cloud oauth enable: no Supabase access token found. Run `supabase login` ' +
      '(or set SUPABASE_ACCESS_TOKEN).',
    );
  }

  log(`==> enabling OAuth 2.1 server on '${profileName}' (ref ${projectRef})`);
  log(`  consent page: ${env.PLANNEN_WEB_URL ?? '<site url>'}${CONSENT_PATH}`);

  const result = await mgmt.updateOAuthServerConfig(token, projectRef, {
    authorizationPath: CONSENT_PATH,
  });

  const connectorUrl = `https://${projectRef}.supabase.co/functions/v1/mcp`;
  log(`==> ${result.changed ? 'updated' : 'already up to date'}`);
  log('');
  log('  Register on claude.ai → Settings → Connectors → Add custom connector:');
  log(`    ${connectorUrl}`);
  log('');
  log('  Connectors propagate to claude.ai web, Claude Desktop, mobile, and');
  log('  Claude in Chrome. Each user logs in with their Plannen account.');
  return { connectorUrl, changed: result.changed };
}

/**
 * Report the project's oauth_server_* auth-config state.
 */
export async function invokeOauthStatus(args, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const mgmt = ctx.supabaseMgmt ?? supabaseMgmt;

  const { profileName, projectRef } = resolveCloudProfile('status', args, baseEnv);

  const token = mgmt.readAccessToken({ env: baseEnv });
  if (!token) {
    throw new Error(
      'cloud oauth status: no Supabase access token found. Run `supabase login` ' +
      '(or set SUPABASE_ACCESS_TOKEN).',
    );
  }

  const config = await mgmt.getAuthConfig(token, projectRef);
  const connectorUrl = `https://${projectRef}.supabase.co/functions/v1/mcp`;
  const status = {
    enabled: config.oauth_server_enabled === true,
    dynamicRegistration: config.oauth_server_allow_dynamic_registration === true,
    authorizationPath: config.oauth_server_authorization_path ?? null,
    connectorUrl,
  };
  log(`==> oauth server on '${profileName}' (ref ${projectRef})`);
  log(`  enabled:               ${status.enabled}`);
  log(`  dynamic registration:  ${status.dynamicRegistration}`);
  log(`  authorization path:    ${status.authorizationPath ?? '(unset)'}`);
  log(`  connector URL:         ${connectorUrl}`);
  return status;
}

const enableCommand = defineCommand({
  meta: {
    name: 'enable',
    description: 'Enable the Supabase OAuth 2.1 server (claude.ai connector support) on a cloud_sb profile',
  },
  args: {
    profile: { type: 'string', description: 'Profile to enable the OAuth server on', required: true },
  },
  async run({ args }) {
    await invokeOauthEnable({ profile: args.profile }, {});
    process.exit(0);
  },
});

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the OAuth server config for a cloud_sb profile' },
  args: {
    profile: { type: 'string', description: 'Profile to inspect', required: true },
  },
  async run({ args }) {
    await invokeOauthStatus({ profile: args.profile }, {});
    process.exit(0);
  },
});

export const oauthCommand = defineCommand({
  meta: { name: 'oauth', description: 'OAuth 2.1 server configuration (claude.ai custom connectors)' },
  subCommands: { enable: enableCommand, status: statusCommand },
});
