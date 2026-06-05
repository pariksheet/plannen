import { defineCommand } from 'citty';
import { profileCreateCommand } from './create.mjs';
import { profileUseCommand } from './use.mjs';
import { profileListCommand } from './list.mjs';
import { profileDeleteCommand } from './delete.mjs';
import { profileSyncModeCommand } from './sync-mode.mjs';

export const profileCommand = defineCommand({
  meta: { name: 'profile', description: 'Manage Plannen profiles (runtime state isolation)' },
  subCommands: {
    create: profileCreateCommand,
    use: profileUseCommand,
    list: profileListCommand,
    delete: profileDeleteCommand,
    'sync-mode': profileSyncModeCommand,
  },
});
