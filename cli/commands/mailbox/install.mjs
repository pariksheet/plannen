import { defineCommand } from 'citty';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildPlist } from '../../lib/launchd-plist.mjs';

export const mailboxInstallCommand = defineCommand({
  meta: { name: 'install', description: 'Write & load the launchd plist for /plannen-mailbox-sync.' },
  args: {
    profile: { type: 'string', description: 'Plannen profile name to run under (default: $PLANNEN_PROFILE or "default").' },
  },
  async run({ args }) {
    const home = homedir();
    const label = 'work.plannen.mailbox-sync';
    const plistDir = join(home, 'Library', 'LaunchAgents');
    const plistPath = join(plistDir, `${label}.plist`);
    const repoRoot = process.cwd();
    const wrapperPath = join(repoRoot, 'scripts', 'mailbox', 'sync-wrapper.sh');
    const profile = args.profile || process.env.PLANNEN_PROFILE || 'default';

    if (!existsSync(wrapperPath)) {
      console.error(`Wrapper script not found at ${wrapperPath} — run from the project root.`);
      process.exit(1);
    }

    await mkdir(plistDir, { recursive: true });
    await mkdir(join(home, '.plannen', 'logs'), { recursive: true });

    const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    const xml = buildPlist({ label, wrapperPath, profile, homeDir: home, pathEnv });
    await writeFile(plistPath, xml, 'utf8');
    await chmod(wrapperPath, 0o755);

    // Reload: bootout first if already loaded, then bootstrap.
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
    const boot = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { encoding: 'utf8' });
    if (boot.status !== 0) {
      console.error('launchctl bootstrap failed:');
      console.error(boot.stderr || boot.stdout);
      process.exit(1);
    }

    console.log(`Installed launchd job '${label}'`);
    console.log(`  Plist:   ${plistPath}`);
    console.log(`  Wrapper: ${wrapperPath}`);
    console.log(`  Profile: ${profile}`);
    console.log(`  Runs:    every 4h around the clock (00, 04, 08, 12, 16, 20) Europe/Brussels`);
    console.log(`  Logs:    ${join(home, '.plannen', 'logs', 'mailbox-sync.log')}`);
    console.log(`Run 'npx plannen mailbox uninstall' to remove.`);
  },
});
