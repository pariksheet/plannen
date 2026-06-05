import { defineCommand } from 'citty';
import { tokenCreateCommand } from './create.mjs';
import { tokenListCommand } from './list.mjs';
import { tokenRevokeCommand } from './revoke.mjs';
import { tokenActivateCommand } from './activate.mjs';
import { tokenRotateCommand } from './rotate.mjs';

export const tokenCommand = defineCommand({
  meta: { name: 'token', description: 'Manage MCP Personal Access Tokens' },
  subCommands: {
    create: tokenCreateCommand,
    list: tokenListCommand,
    revoke: tokenRevokeCommand,
    activate: tokenActivateCommand,
    rotate: tokenRotateCommand,
  },
});
