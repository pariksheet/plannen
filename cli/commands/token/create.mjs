import { defineCommand } from 'citty';
import pg from 'pg';
import {
  resolveActiveProfile,
  getProfileEnvPath,
  readEnvFile,
  writeEnvFile,
  composeEnv,
} from '../../lib/profiles.mjs';
import { mintToken } from '../../../scripts/lib/userTokens.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function defaultRewritePluginJson(env) {
  const r = spawnSync('bash', ['scripts/mcp-mode.sh', 'http'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`mcp-mode.sh exited ${r.status}`);
}

export async function runTokenCreate(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const label = String(args.label ?? '').trim();
  if (!label) throw new Error('label is required (use --label "MacBook")');

  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  let plaintext;
  let tokenId;
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      );
      if (rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      const userId = rows[0].id;
      const r = await mintToken(client, userId, label, args.expires ?? null);
      plaintext = r.plaintext;
      tokenId = r.id;
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }

  if (!args['no-activate']) {
    const envPath = getProfileEnvPath(profile, env);
    const current = readEnvFile(envPath);
    current.MCP_BEARER_TOKEN = plaintext;
    writeEnvFile(envPath, current);
    const rewrite = ctx.rewritePluginJson ?? defaultRewritePluginJson;
    rewrite({ ...process.env, ...composed, MCP_BEARER_TOKEN: plaintext });
  }

  const log = ctx.log ?? console;
  log.info?.(`Token created (label: ${label})`);
  log.info?.(plaintext);
  log.info?.('');
  if (args['no-activate']) {
    log.info?.('Save this token now — you will not see it again.');
  } else {
    log.info?.(`Saved to profile "${profile}" as MCP_BEARER_TOKEN.`);
    log.info?.('Updated plugin/.claude-plugin/plugin.json.');
    log.info?.('Reload the plannen plugin in Claude Code to pick it up.');
  }

  return { id: tokenId, plaintext, label };
}

export const tokenCreateCommand = defineCommand({
  meta: { name: 'create', description: 'Create a new MCP Personal Access Token' },
  args: {
    label: { type: 'string', description: 'Token label (e.g. "MacBook")', required: true },
    expires: { type: 'string', description: 'ISO date when the token expires (optional)' },
    'no-activate': { type: 'boolean', description: 'Skip wiring to profile env + plugin.json' },
  },
  async run({ args }) {
    await runTokenCreate(args, {});
  },
});
