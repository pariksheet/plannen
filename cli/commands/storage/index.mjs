import { defineCommand } from 'citty';
import { storageMigrateCommand } from './migrate.mjs';

export const storageCommand = defineCommand({
  meta: { name: 'storage', description: 'Storage tooling' },
  subCommands: { migrate: storageMigrateCommand },
});
