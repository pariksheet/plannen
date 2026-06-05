import { defineCommand } from 'citty';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const mailboxUninstallCommand = defineCommand({
  meta: { name: 'uninstall', description: 'Stop and remove the launchd plist.' },
  async run() {
    const home = homedir();
    const label = 'work.plannen.mailbox-sync';
    const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);

    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
    if (existsSync(plistPath)) {
      await unlink(plistPath);
      console.log(`Removed ${plistPath}`);
    } else {
      console.log(`No plist found at ${plistPath} — nothing to remove.`);
    }
  },
});
