import { defineCommand } from 'citty';
import { detectModeDrift, listProfiles, resolveActiveProfile } from '../../lib/profiles.mjs';

const NAME_PAD = 16;
const MODE_PAD = 10;
const OFFSET_PAD = 11;
const ACTIVE_PAD = 7;

export async function invokeProfileList(rawArgs, ctx = {}) {
  const env = ctx.env ?? process.env;
  const out = ctx.out ?? process.stdout;
  const active = resolveActiveProfile(env);
  const profiles = listProfiles(env);
  const enriched = profiles.map((p) => ({ ...p, drift: detectModeDrift({ name: p.name, env }) }));

  if (rawArgs.json) {
    out.write(JSON.stringify({ active, profiles: enriched }, null, 2) + '\n');
    return 0;
  }
  if (enriched.length === 0) {
    out.write('(no profiles — run `plannen profile create <name> --mode=local_pg`)\n');
    return 0;
  }
  out.write(`${'NAME'.padEnd(NAME_PAD)} ${'MODE'.padEnd(MODE_PAD)} ${'OFFSET'.padEnd(OFFSET_PAD)} ${'ACTIVE'.padEnd(ACTIVE_PAD)} STATUS\n`);
  let anyDrift = false;
  for (const p of enriched) {
    const star = p.name === active ? '*' : ' ';
    const status = p.drift
      ? `drift: env tier=${p.drift.env_tier} → expected mode=${p.drift.expected_mode}`
      : 'ok';
    if (p.drift) anyDrift = true;
    out.write(`${String(p.name).padEnd(NAME_PAD)} ${String(p.mode).padEnd(MODE_PAD)} ${String(p.port_offset).padEnd(OFFSET_PAD)} ${star.padEnd(ACTIVE_PAD)} ${status}\n`);
  }
  if (anyDrift) {
    out.write('\nFix drift with: plannen profile sync-mode [name]\n');
  }
  return 0;
}

export const profileListCommand = defineCommand({
  meta: { name: 'list', description: 'List all profiles' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON instead of human-readable lines' },
  },
  async run({ args }) {
    const code = await invokeProfileList(args);
    process.exit(code);
  },
});
