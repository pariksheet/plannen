import { defineCommand } from 'citty';
import { functionsDeployCommand } from './deploy.mjs';

export const functionsCommand = defineCommand({
  meta: {
    name: 'functions',
    description: 'Manage Plannen edge functions (Supabase Edge).',
  },
  subCommands: {
    deploy: functionsDeployCommand,
  },
});
