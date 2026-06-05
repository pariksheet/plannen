import { defineCommand } from 'citty';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  resolveActiveProfile,
  composeEnv,
  getProfileEnvPath,
  readEnvFile,
  writeEnvFile,
} from '../../lib/profiles.mjs';
import { mintToken, revokeToken } from '../../../scripts/lib/userTokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function defaultRewritePluginJson(env) {
  const r = spawnSync('bash', ['scripts/mcp-mode.sh', 'http'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`mcp-mode.sh exited ${r.status}`);
}

export async function runTokenRotate(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  const current = composed.MCP_BEARER_TOKEN;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');
  if (!current) throw new Error('MCP_BEARER_TOKEN not set in active profile env — nothing to rotate');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  let newPat;
  try {
    const client = await pool.connect();
    try {
      const u = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1', [email],
      );
      if (u.rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      const userId = u.rows[0].id;

      // Look up the existing token by hash; revoke if found (silent no-op if not).
      const hash = createHash('sha256').update(current).digest();
      const existing = await client.query(
        `SELECT id FROM plannen.user_tokens WHERE user_id = $1 AND token_hash = $2 LIMIT 1`,
        [userId, hash],
      );
      if (existing.rows.length > 0) {
        await revokeToken(client, userId, existing.rows[0].id);
      }

      const label = `rotated-${new Date().toISOString().slice(0, 10)}`;
      const r = await mintToken(client, userId, label);
      newPat = r.plaintext;
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }

  const envPath = getProfileEnvPath(profile, env);
  const e = readEnvFile(envPath);
  e.MCP_BEARER_TOKEN = newPat;
  writeEnvFile(envPath, e);

  const rewrite = ctx.rewritePluginJson ?? defaultRewritePluginJson;
  rewrite({ ...process.env, ...composed, MCP_BEARER_TOKEN: newPat });

  const log = ctx.log ?? console;
  log.info?.('Rotated MCP_BEARER_TOKEN.');
  log.info?.(newPat);
  log.info?.('Reload the plannen plugin in Claude Code to pick it up.');
}

export const tokenRotateCommand = defineCommand({
  meta: { name: 'rotate', description: 'Revoke the current MCP_BEARER_TOKEN and mint a fresh one' },
  async run({ args }) { await runTokenRotate(args, {}); },
});
