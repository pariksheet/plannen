import { defineCommand } from 'citty';
import { invokeInit } from '../lib/init.mjs';

// Thin citty wrapper around invokeInit. All of the install logic — pre-flight,
// email cascade, dependency install, tier branching, .env writes, plugin
// install, Claude Desktop, skills, whisper, final printout — lives in
// cli/lib/init.mjs. Tests import invokeInit directly with dep-injected ctx.
export { invokeInit };

export const initCommand = defineCommand({
  meta: { name: 'init', description: 'Bootstrap Plannen (preflight + tier setup + plugin install)' },
  args: {
    mode: { type: 'string', description: 'Deployment mode: local_pg | local_sb | cloud_sb (or tier0|tier1|tier2). Defaults to the existing profile\'s mode when omitted.' },
    profile: { type: 'string', description: 'Profile name to create or reuse (defaults to "default")' },
    email: { type: 'string', description: 'User email for the auth user row' },
    'non-interactive': { type: 'boolean', description: 'Fail rather than prompt' },
    'install-plugin': { type: 'boolean', description: 'Install the Claude Code plugin (--non-interactive only)' },
    'start-dev': { type: 'boolean', description: 'Start the web dev server (--non-interactive only)' },
    'configure-desktop': { type: 'boolean', description: 'Merge plannen MCP into Claude Desktop config (--non-interactive only)' },
    'install-skills': { type: 'boolean', description: 'Symlink plannen skills into ~/.claude/skills (--non-interactive only)' },
    'project-ref': { type: 'string', description: 'Tier 2: Supabase Cloud project ref (defaults to SUPABASE_PROJECT_REF in .env)' },
    'cloud-db-url': { type: 'string', description: 'Tier 2: full pg URL for cloud DB (required for data restore step)' },
    'force-overwrite': { type: 'boolean', description: 'Tier 2: replace existing cloud data during restore' },
    'accept-storage-quota': { type: 'boolean', description: 'Tier 2: proceed even if photo bucket > 1 GB' },
    'skip-photos': { type: 'boolean', description: 'Tier 2: skip the photo upload step' },
    'skip-vercel': { type: 'boolean', description: 'Tier 2: skip the "Deploy to Vercel?" prompt' },
  },
  async run({ args }) {
    const code = await invokeInit(args);
    process.exit(code ?? 0);
  },
});
