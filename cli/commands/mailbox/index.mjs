import { defineCommand } from 'citty';
import { mailboxInstallCommand } from './install.mjs';
import { mailboxUninstallCommand } from './uninstall.mjs';

export const mailboxCommand = defineCommand({
  meta: { name: 'mailbox', description: 'Manage the mailbox-sync launchd job.' },
  subCommands: {
    install: mailboxInstallCommand,
    uninstall: mailboxUninstallCommand,
  },
});
