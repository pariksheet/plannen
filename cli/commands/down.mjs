import { defineCommand } from 'citty';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { runScript } from '../lib/runScript.mjs';
import { composeEnv, profileExists, resolveActiveProfile } from '../lib/profiles.mjs';

/**
 * Tear down the right stack for the active profile's tier. Mirrors what the
 * deleted scripts/stop.sh used to dispatch. Always tolerant of "already
 * stopped" — never blocks on a sub-script's non-zero exit.
 *
 *   tier 0 → dev-stop.sh → backend-stop.sh → pg-stop.sh
 *   tier 1 → dev-stop.sh → functions-stop.sh → `supabase stop --project-id plannen`
 *   tier 2 → dev-stop.sh (cloud Supabase + MCP have nothing local to stop)
 */
export async function invokeDown(rawArgs, ctx = {}) {
  const baseEnv = ctx.env ?? process.env;
  const log = ctx.log ?? ((s) => process.stdout.write(`${s}\n`));
  const run = ctx.runScript ?? runScript;
  const spawnSync = ctx.spawnSync ?? defaultSpawnSync;
  const spawner = ctx.spawner;

  const profileName = rawArgs.profile ?? resolveActiveProfile(baseEnv);
  // Down with no profile is a no-op-friendly path — still try to stop
  // anything that might be running, but don't fail loudly.
  const composed = profileName && profileExists(profileName, baseEnv)
    ? composeEnv(profileName, {}, baseEnv)
    : baseEnv;
  const tier = composed.PLANNEN_TIER ?? '0';

  log(`Stopping Plannen (Tier ${tier})…`);

  // Dev server first (it touches both tiers).
  await run({ script: 'scripts/dev-stop.sh', env: composed, spawner }).catch(() => {});

  if (tier === '0') {
    await run({ script: 'scripts/backend-stop.sh', env: composed, spawner }).catch(() => {});
    await run({ script: 'scripts/pg-stop.sh', env: composed, spawner }).catch(() => {});
  } else if (tier === '1') {
    await run({ script: 'scripts/functions-stop.sh', env: composed, spawner }).catch(() => {});
    log('→ supabase stop --project-id plannen');
    try {
      spawnSync('supabase', ['stop', '--project-id', 'plannen'], {
        stdio: 'inherit',
        env: composed,
      });
    } catch {
      // tolerate — supabase CLI may not be installed in some Tier 1 dev shells
    }
  } else if (tier === '2') {
    log('→ tier 2: cloud Supabase + MCP — only web dev server was local');
  }

  log('✓ stopped.');
  return 0;
}

export const downCommand = defineCommand({
  meta: { name: 'down', description: "Stop Plannen's processes for the active profile" },
  args: {
    profile: { type: 'string', description: 'Profile to use (defaults to the active profile)' },
  },
  async run({ args }) {
    const code = await invokeDown(args);
    process.exit(code);
  },
});
