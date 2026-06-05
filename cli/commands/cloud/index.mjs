import { defineCommand } from 'citty';
import { provisionCommand } from './provision.mjs';
import { passkeysCommand } from './passkeys.mjs';
import { oauthCommand } from './oauth.mjs';

export const cloudCommand = defineCommand({
  meta: { name: 'cloud', description: 'Cloud (Tier 2) provisioning + lifecycle' },
  subCommands: {
    provision: provisionCommand,
    passkeys: passkeysCommand,
    oauth: oauthCommand,
  },
});
