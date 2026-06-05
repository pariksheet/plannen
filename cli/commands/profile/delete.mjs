import { defineCommand } from 'citty';
import { rmSync } from 'node:fs';
import {
  getProfileDir,
  profileExists,
  resolveActiveProfile,
} from '../../lib/profiles.mjs';

export async function invokeProfileDelete(rawArgs, ctx = {}) {
  const env = ctx.env ?? process.env;
  const name = rawArgs.name;
  const yes = rawArgs.yes ?? false;

  if (!name) throw new Error('profile delete: <name> is required');
  if (!profileExists(name, env)) throw new Error(`profile delete: '${name}' does not exist`);
  if (resolveActiveProfile(env) === name) {
    throw new Error(
      `profile delete: cannot delete active profile '${name}'. ` +
      `Switch to another profile first.`,
    );
  }
  if (!yes) {
    throw new Error(
      `profile delete: refusing to delete '${name}' without --yes. ` +
      `This permanently removes the profile dir (pgdata + photos + env).`,
    );
  }

  rmSync(getProfileDir(name, env), { recursive: true, force: true });
  return 0;
}

export const profileDeleteCommand = defineCommand({
  meta: { name: 'delete', description: 'Delete a profile (irreversibly)' },
  args: {
    name: { type: 'positional', description: 'Profile name', required: true },
    yes: { type: 'boolean', description: 'Skip the safety check; required for non-interactive use' },
  },
  async run({ args }) {
    const code = await invokeProfileDelete(args);
    process.stdout.write(`deleted profile '${args.name}'\n`);
    process.exit(code);
  },
});
