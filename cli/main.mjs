import { defineCommand, runMain } from 'citty';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initCommand } from './commands/init.mjs';
import { upCommand } from './commands/up.mjs';
import { downCommand } from './commands/down.mjs';
import { statusCommand } from './commands/status.mjs';
import { profileCommand } from './commands/profile/index.mjs';
import { deployCommand } from './commands/deploy.mjs';
import { cloudCommand } from './commands/cloud/index.mjs';
import { promoteCommand } from './commands/promote.mjs';
import { migrateCommand } from './commands/migrate.mjs';
import { backupCommand } from './commands/backup.mjs';
import { functionsCommand } from './commands/functions/index.mjs';
import { tokenCommand } from './commands/token/index.mjs';
import { mailboxCommand } from './commands/mailbox/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// Load .env so commands see PLANNEN_TIER and friends without manual export.
// override:false keeps an explicit `PLANNEN_TIER=1 npx plannen status` winning.
// quiet:true silences dotenv's stdout banner so JSON output stays parseable.
loadDotenv({ path: path.join(REPO_ROOT, '.env'), override: false, quiet: true });

const main = defineCommand({
  meta: {
    name: 'plannen',
    version: pkg.version,
    description: 'Plannen CLI — manage your local + cloud deployments.',
  },
  subCommands: {
    init: initCommand,
    up: upCommand,
    down: downCommand,
    status: statusCommand,
    profile: profileCommand,
    deploy: deployCommand,
    cloud: cloudCommand,
    promote: promoteCommand,
    migrate: migrateCommand,
    backup: backupCommand,
    functions: functionsCommand,
    token: tokenCommand,
    mailbox: mailboxCommand,
  },
});

export function run() {
  return runMain(main);
}
