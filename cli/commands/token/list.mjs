import { defineCommand } from 'citty';
import pg from 'pg';
import {
  resolveActiveProfile,
  composeEnv,
} from '../../lib/profiles.mjs';
import { listTokens } from '../../../scripts/lib/userTokens.mjs';

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

export async function runTokenList(args, ctx = {}) {
  const env = ctx.env ?? process.env;
  const profile = ctx.profile ?? resolveActiveProfile(env) ?? 'default';
  const composed = composeEnv(profile, {}, env);
  const email = composed.PLANNEN_USER_EMAIL;
  const dbUrl = composed.DATABASE_URL;
  if (!email) throw new Error('PLANNEN_USER_EMAIL not set in active profile env');
  if (!dbUrl) throw new Error('DATABASE_URL not set in active profile env');

  const poolFactory = ctx.poolFactory ?? (() => new pg.Pool({ connectionString: dbUrl }));
  const pool = poolFactory();
  let rows;
  try {
    const client = await pool.connect();
    try {
      const r = await client.query(
        'SELECT id FROM plannen.users WHERE lower(email) = lower($1) LIMIT 1',
        [email],
      );
      if (r.rows.length === 0) throw new Error(`No Plannen user found for ${email}`);
      rows = await listTokens(client, r.rows[0].id);
    } finally {
      client.release();
    }
  } finally {
    if (pool.end) await pool.end();
  }

  const log = ctx.log ?? console;
  if (rows.length === 0) {
    log.info?.('No tokens. Run `plannen token create --label <name>` to mint one.');
    return rows;
  }
  log.info?.(['ID', 'LABEL', 'PREFIX', 'CREATED', 'LAST USED', 'EXPIRES'].join('\t'));
  for (const r of rows) {
    log.info?.([
      r.id.slice(0, 8), r.label, r.prefix, fmt(r.created_at), fmt(r.last_used_at), fmt(r.expires_at),
    ].join('\t'));
  }
  return rows;
}

export const tokenListCommand = defineCommand({
  meta: { name: 'list', description: 'List your MCP Personal Access Tokens' },
  async run({ args }) { await runTokenList(args, {}); },
});
