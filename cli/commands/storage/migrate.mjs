// cli/commands/storage/migrate.mjs
//
// `plannen storage migrate --from X --to Y --profile NAME` copies every key
// in plannen.event_memories.storage_key from the source backend to the
// target backend. Does NOT flip PLANNEN_STORAGE_BACKEND — the operator
// does that manually after the run completes successfully.
//
// The pure core (migrateKeys) is exported for tests; the citty command
// wires it to real adapters + a Postgres pool.

import { defineCommand } from 'citty';
import { composeEnv } from '../../lib/profiles.mjs';

/**
 * Pure-ish core: walks `keys`, head-checks the target, downloads from source,
 * uploads to target. Returns counts.
 *
 * @param {{
 *   keys: string[],
 *   source: { head(k: string): Promise<{size:number}|null> },
 *   target: { head(k: string): Promise<{size:number}|null>, upload(k: string, bytes: Uint8Array, opts: object): Promise<void> },
 *   downloadFn: (key: string) => Promise<Uint8Array | null>,
 *   onProgress?: (key: string, status: 'copied'|'skipped'|'failed', err?: Error) => void,
 * }} args
 */
export async function migrateKeys({ keys, source, target, downloadFn, onProgress }) {
  let copied = 0, skipped = 0, failed = 0;
  for (const key of keys) {
    try {
      const srcHead = await source.head(key);
      if (!srcHead) {
        skipped++;
        onProgress?.(key, 'skipped');
        continue;
      }
      const tgtHead = await target.head(key);
      if (tgtHead && tgtHead.size === srcHead.size) {
        skipped++;
        onProgress?.(key, 'skipped');
        continue;
      }
      const bytes = await downloadFn(key);
      if (!bytes) {
        failed++;
        onProgress?.(key, 'failed', new Error('source returned no bytes'));
        continue;
      }
      await target.upload(key, bytes, {
        contentType: srcHead.contentType ?? 'application/octet-stream',
      });
      copied++;
      onProgress?.(key, 'copied');
    } catch (e) {
      failed++;
      onProgress?.(key, 'failed', e);
    }
  }
  return { copied, skipped, failed };
}

export const storageMigrateCommand = defineCommand({
  meta: { name: 'migrate', description: 'Copy photo bytes between storage backends' },
  args: {
    from: { type: 'string', description: 'Source backend: supabase | s3 | local-fs', required: true },
    to:   { type: 'string', description: 'Target backend: supabase | s3 | local-fs', required: true },
    profile: { type: 'string', description: 'Profile whose env supplies credentials for BOTH backends' },
    'verify-only': { type: 'boolean', description: 'HEAD-compare only, do not upload' },
  },
  async run({ args }) {
    if (args.from === args.to) throw new Error('migrate: --from and --to must differ');
    const env = composeEnv(args.profile ?? process.env.PLANNEN_PROFILE);
    const { buildAdapterForBackend, buildDownloadFn } = await import('../../lib/storage-runtime.mjs');
    const source = buildAdapterForBackend(args.from, env);
    const target = buildAdapterForBackend(args.to, env);
    const downloadFn = buildDownloadFn(args.from, env, source);

    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
    const { rows } = await pool.query(
      `SELECT DISTINCT storage_key FROM plannen.event_memories WHERE storage_key IS NOT NULL ORDER BY storage_key`,
    );
    const keys = rows.map((r) => r.storage_key);
    process.stdout.write(`storage migrate: ${keys.length} key(s) to consider\n`);

    if (args['verify-only']) {
      let mismatch = 0;
      for (const k of keys) {
        const [s, t] = await Promise.all([source.head(k), target.head(k)]);
        if (!t || (s && t.size !== s.size)) mismatch++;
      }
      process.stdout.write(`verify: ${keys.length - mismatch}/${keys.length} present and size-match\n`);
      await pool.end();
      process.exit(mismatch === 0 ? 0 : 1);
    }

    const out = await migrateKeys({
      keys, source, target, downloadFn,
      onProgress: (k, s) => process.stdout.write(`  ${s}\t${k}\n`),
    });
    process.stdout.write(`done: copied=${out.copied} skipped=${out.skipped} failed=${out.failed}\n`);
    await pool.end();
    process.exit(out.failed === 0 ? 0 : 1);
  },
});
