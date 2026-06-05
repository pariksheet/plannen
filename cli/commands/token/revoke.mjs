import { defineCommand } from 'citty';
import pg from 'pg';
import { resolveActiveProfile, composeEnv } from '../../lib/profiles.mjs';
import { revokeToken } from '../../../scripts/lib/userTokens.mjs';

export async function runTokenRevoke(args, ctx = {}) {
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('id is required (use: plannen token revoke <id>)');

  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  try {
    const client = await pool.connect();
    try {
      const u = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      );
      if (u.rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      const userId = u.rows[0].id;
      // Support short-id prefix from `plannen token list`.
      const fullIdRows = await client.query(
        `SELECT id FROM plannen.user_tokens WHERE user_id = $1 AND id::text LIKE $2 LIMIT 2`,
        [userId, id + '%'],
      );
      if (fullIdRows.rows.length === 0) throw new Error(`token not found for id "${id}"`);
      if (fullIdRows.rows.length > 1) throw new Error(`id prefix "${id}" is ambiguous — use full UUID from \`plannen token list\``);
      const ok = await revokeToken(client, userId, fullIdRows.rows[0].id);
      if (!ok) throw new Error(`token not found for id "${id}"`);
      const log = ctx.log ?? console;
      log.info?.(`Revoked token ${fullIdRows.rows[0].id}`);
      return true;
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }
}

export const tokenRevokeCommand = defineCommand({
  meta: { name: 'revoke', description: 'Revoke an MCP Personal Access Token by id' },
  args: { id: { type: 'positional', required: true } },
  async run({ args }) { await runTokenRevoke(args, {}); },
});
