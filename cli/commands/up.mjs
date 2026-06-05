import { defineCommand } from 'citty';
import { runScript } from '../lib/runScript.mjs';
import { composeEnv, profileExists, resolveActiveProfile } from '../lib/profiles.mjs';

/**
 * Bring up the right stack for the active profile's tier. Mirrors what the
 * deleted scripts/start.sh used to dispatch:
 *   tier 0 → pg-start.sh + backend-start.sh ( + dev-start.sh unless --no-dev)
 *   tier 1 → local-start.sh + functions-start.sh ( + dev-start.sh unless --no-dev)
 *   tier 2 → dev-start.sh only ( + nothing local; Supabase + MCP live in cloud)
 */
export async function invokeUp(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const run = ctx.runScript ?? runScript;
  const spawner = ctx.spawner;

  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  if (!profileName) {
    throw new Error('up: no active profile. Run `plannen init --mode=<m>` first, or pass --profile=<name>.');
  }
  if (!profileExists(profileName, baseEnv)) {
    throw new Error(`up: profile '${profileName}' does not exist`);
  }
  const composed = composeEnv(profileName, {}, baseEnv);
  const tier = composed.PLANNEN_TIER ?? '0';

  log(`Starting Plannen (Tier ${tier})…`);

  if (tier === '0') {
    const r1 = await run({ script: 'scripts/pg-start.sh', env: composed, spawner });
    if (r1 !== 0) return r1;
    const r2 = await run({ script: 'scripts/backend-start.sh', env: composed, spawner });
    if (r2 !== 0) return r2;
  } else if (tier === '1') {
    const r1 = await run({ script: 'scripts/local-start.sh', env: composed, spawner });
    if (r1 !== 0) return r1;
    const r2 = await run({ script: 'scripts/functions-start.sh', env: composed, spawner });
    if (r2 !== 0) return r2;
  } else if (tier === '2') {
    log('→ tier 2: cloud Supabase + MCP — nothing local to start (web dev below)');
  } else {
    throw new Error(`up: unknown tier '${tier}' on profile '${profileName}'`);
  }

  const noDev = rawArgs['no-dev'] ?? rawArgs.noDev;
  if (noDev) {
    log('→ skipping web dev server (--no-dev)');
  } else {
    const rDev = await run({ script: 'scripts/dev-start.sh', env: composed, spawner });
    if (rDev !== 0) return rDev;
  }

  log('✓ started. Web app: http://localhost:4321  (set --no-dev to skip)');
  return 0;
}

export const upCommand = defineCommand({
  meta: { name: 'up', description: "Start Plannen's processes for the active profile" },
  args: {
    profile: { type: 'string', description: 'Profile to use (defaults to the active profile)' },
    'no-dev': { type: 'boolean', description: 'Skip the web dev server' },
  },
  async run({ args }) {
    const code = await invokeUp(args);
    process.exit(code);
  },
});
