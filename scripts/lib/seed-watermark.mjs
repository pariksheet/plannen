// Seed-dump migration watermark (#16).
//
// A seed.sql dump is data-only and schema-coupled: it only applies cleanly to
// the schema that existed when it was exported. The watermark records that
// schema version (the latest applied migration) as a comment header inside
// the dump, so restore paths can replay correctly: apply migrations up to the
// watermark, load the dump, then migrate forward.

const WATERMARK_RE = /^-- plannen:watermark (\S+)$/m;

/** Header line to embed at the top of a seed dump. */
export function watermarkHeader(version) {
  return `-- plannen:watermark ${version}`;
}

/** Extract the watermark from seed-dump text, or null for pre-#16 dumps. */
export function readSeedWatermark(seedText) {
  return seedText.match(WATERMARK_RE)?.[1] ?? null;
}

/**
 * Is `version` within the bound? Used by migrate.mjs --to: migrations sort
 * lexicographically (timestamped filenames), and the Tier 0 overlay's
 * 00000000000000_* versions sort below every real bound by construction.
 */
export function withinBound(version, bound) {
  return !bound || version <= bound;
}

/** Applied versions strictly newer than the watermark (overlay excluded). */
export function versionsNewerThan(appliedVersions, watermark) {
  return appliedVersions
    .filter((v) => !v.startsWith('00000000000000_'))
    .filter((v) => v > watermark)
    .sort();
}

/**
 * Latest applied migration version in the source DB, for stamping exports.
 * Tries the Tier 0/1 tracking table first, then Supabase CLI's (Tier 2).
 * Returns null when neither exists (nothing to stamp).
 */
export async function latestAppliedVersion(client) {
  for (const table of ['plannen.schema_migrations', 'supabase_migrations.schema_migrations']) {
    try {
      const { rows } = await client.query(
        `SELECT version FROM ${table} WHERE version NOT LIKE '00000000000000\\_%' ORDER BY version DESC LIMIT 1`,
      );
      if (rows.length) return rows[0].version;
    } catch {
      // table absent — try the next tracker
    }
  }
  return null;
}
