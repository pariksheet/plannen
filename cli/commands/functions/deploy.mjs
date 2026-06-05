import { defineCommand } from 'citty';

import {
  composeEnv,
  profileExists,
  resolveActiveProfile,
} from '../../lib/profiles.mjs';
import * as cloudDeploy from '../../../scripts/lib/cloud-deploy.mjs';

/**
 * Deploy (or redeploy) all Supabase Edge Functions for the active profile.
 *
 * Only meaningful on Tier 2 (cloud_sb) — Tier 0/1 don't deploy edge functions
 * to a remote Supabase project.
 *
 * The verb reuses the bearer token already in the composed env so repeated
 * deploys don't rotate the token. To rotate, update the profile env file first.
 */
export async function invokeFunctionsDeploy(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const cloudDeployRun = ctx.cloudDeployRun ?? cloudDeploy.run;

  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  if (!profileName) {
    throw new Error(
      'functions deploy: no active profile. Pass --profile=<name> or run `plannen init` first.',
    );
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`functions deploy: profile '${profileName}' does not exist`);
  }

  const composed = composeEnv(profileName, {}, baseEnv);
  const tier = composed.PLANNEN_TIER ?? '0';

  if (tier !== '2') {
    throw new Error(
      `functions deploy: profile '${profileName}' is Tier ${tier}. ` +
      'Edge functions are only deployed on Tier 2 (cloud_sb) profiles.',
    );
  }

  if (!composed.SUPABASE_PROJECT_REF) {
    throw new Error(
      `functions deploy: profile '${profileName}' is missing SUPABASE_PROJECT_REF`,
    );
  }

  log(`Deploying edge functions for profile '${profileName}' (project: ${composed.SUPABASE_PROJECT_REF})…`);

  const result = await cloudDeployRun(
    {
      projectRef: composed.SUPABASE_PROJECT_REF,
      userEmail: composed.PLANNEN_USER_EMAIL,
      googleClientId: composed.GOOGLE_CLIENT_ID,
      googleClientSecret: composed.GOOGLE_CLIENT_SECRET,
      anthropicApiKey: composed.ANTHROPIC_API_KEY,
      extraSecrets: {
        ...(composed.VAPID_PUBLIC_KEY ? { VAPID_PUBLIC_KEY: composed.VAPID_PUBLIC_KEY } : {}),
        ...(composed.VAPID_PRIVATE_KEY ? { VAPID_PRIVATE_KEY: composed.VAPID_PRIVATE_KEY } : {}),
        ...(composed.VAPID_SUBJECT ? { VAPID_SUBJECT: composed.VAPID_SUBJECT } : {}),
      },
    },
    { cli: ctx.cli },
  );

  const names = result.deployedFunctions ?? [];
  log(`Deployed ${names.length} function(s): ${names.join(', ')}`);

  return 0;
}

export const functionsDeployCommand = defineCommand({
  meta: {
    name: 'deploy',
    description: 'Deploy all edge functions for the active profile (Tier 2 / cloud_sb only)',
  },
  args: {
    profile: { type: 'string', description: 'Profile to deploy (defaults to the active profile)' },
  },
  async run({ args }) {
    try {
      const code = await invokeFunctionsDeploy(args);
      process.exit(code);
    } catch (err) {
      process.stderr.write(`functions deploy: ${err.message}\n`);
      process.exit(1);
    }
  },
});
