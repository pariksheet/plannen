import { defineCommand } from 'citty';
import {
  VALID_MODES,
  composeEnv,
  getProfileEnvPath,
  modeToTier,
  nextPortOffset,
  portsFor,
  profileExists,
  writeEnvFile,
  writeManifest,
} from '../../lib/profiles.mjs';

export async function invokeProfileCreate(rawArgs, ctx = {}) {
  const env = ctx.env ?? process.env;
  const now = ctx.now ?? (() => new Date().toISOString());
  const name = rawArgs.name;
  const mode = rawArgs.mode;
  const force = rawArgs.force ?? false;

  if (!name) throw new Error('profile create: <name> is required');
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`profile create: --mode must be one of: ${VALID_MODES.join(', ')}`);
  }
  if (profileExists(name, env) && !force) {
    throw new Error(`profile create: '${name}' already exists (use --force to overwrite)`);
  }

  const portOffset = nextPortOffset(env);
  const manifest = {
    name,
    mode,
    port_offset: portOffset,
    created_at: now(),
  };
  writeManifest(name, manifest, env);
  // Don't write PLANNEN_PROFILE into the env file — composeEnv injects it
  // at runtime. Storing it here would make dotenv leak the name into shells
  // that source <repo>/.env directly.
  writeEnvFile(getProfileEnvPath(name, env), {
    PLANNEN_TIER: modeToTier(mode),
    ...portsFor(mode, portOffset),
  });
  return { manifest, envPath: getProfileEnvPath(name, env) };
}

export const profileCreateCommand = defineCommand({
  meta: { name: 'create', description: 'Create a new profile' },
  args: {
    name: { type: 'positional', description: 'Profile name', required: true },
    mode: { type: 'string', description: 'Deployment mode: local_pg | local_sb | cloud_sb', required: true },
    force: { type: 'boolean', description: 'Overwrite if a profile with this name exists' },
  },
  async run({ args }) {
    const { manifest, envPath } = await invokeProfileCreate(args);
    process.stdout.write(`created profile '${manifest.name}' (mode=${manifest.mode}, port_offset=${manifest.port_offset})\n`);
    process.stdout.write(`env file: ${envPath}\n`);
    process.exit(0);
  },
});
