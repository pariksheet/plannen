import { defineCommand } from 'citty';
import {
  resolveActiveProfile,
  syncManifestMode,
  profileExists,
} from '../../lib/profiles.mjs';

export async function invokeProfileSyncMode(rawArgs, ctx = {}) {
  const env = ctx.env ?? process.env;
  const out = ctx.out ?? process.stdout;
  const err = ctx.err ?? process.stderr;
  const name = rawArgs.name ?? resolveActiveProfile(env);

  if (!name) {
    err.write('profile sync-mode: no profile name given and no active profile set\n');
    return 1;
  }
  if (!profileExists(name, env)) {
    err.write(`profile sync-mode: profile not found: ${name}\n`);
    return 1;
  }

  const result = syncManifestMode({ name, env });
  if (rawArgs.json) {
    out.write(JSON.stringify({ name, ...result }, null, 2) + '\n');
    return 0;
  }
  if (result.changed) {
    out.write(`profile '${name}' mode: ${result.before} → ${result.after}\n`);
  } else if (!rawArgs.quiet) {
    if (result.reason === 'in-sync') {
      out.write(`profile '${name}' already in sync (mode=${result.after})\n`);
    } else {
      out.write(`profile '${name}': no change (${result.reason})\n`);
    }
  }
  return 0;
}

export const profileSyncModeCommand = defineCommand({
  meta: {
    name: 'sync-mode',
    description: "Rewrite a profile's manifest mode to match its env file's PLANNEN_TIER",
  },
  args: {
    name: { type: 'positional', description: 'Profile name (defaults to active profile)', required: false },
    json: { type: 'boolean', description: 'Emit JSON result' },
    quiet: { type: 'boolean', description: 'Suppress no-change output' },
  },
  async run({ args }) {
    const code = await invokeProfileSyncMode(args);
    process.exit(code);
  },
});
