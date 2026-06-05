import { spawnSync } from 'node:child_process';

/**
 * Apply pending migrations to a Tier 2 (cloud_sb) Supabase project.
 *
 * The Supabase CLI's `db push` subcommand does NOT accept `--project-ref`
 * (only `link` does). The correct sequence is therefore:
 *
 *   1. supabase link --project-ref <ref>
 *   2. supabase db push --linked
 *
 * Older versions of this script invoked `db push --project-ref <ref>`
 * directly, which the current Supabase CLI rejects with "unknown flag:
 * --project-ref". That regression went unnoticed because CI's
 * release-staging workflow shells out to `supabase db push --linked`
 * directly and never went through `plannen migrate`.
 *
 * Side effects are dep-injectable via `supabaseCli` so the happy-path and
 * failure-path tests in cli/__tests__/migrate-tier2.test.mjs can drive
 * this without spawning a real CLI.
 */
export async function runMigrateTier2({
  projectRef,
  env = process.env,
  supabaseCli = defaultSupabaseCli,
  log = (s) => process.stdout.write(`${s}\n`),
}) {
  if (!projectRef) {
    throw new Error('SUPABASE_PROJECT_REF required for Tier 2 migrations');
  }

  log(`tier 2 → supabase link --project-ref ${projectRef}`);
  const linkRes = supabaseCli(['link', '--project-ref', projectRef], { env });
  if (linkRes.status !== 0) {
    throw new Error(`supabase link → exit ${linkRes.status}: ${linkRes.stderr || linkRes.stdout}`);
  }

  const pushArgs = ['db', 'push', '--linked'];
  if (env.SUPABASE_DB_PUSH_INCLUDE_ALL === '1') pushArgs.push('--include-all');

  log(`tier 2 → supabase ${pushArgs.join(' ')}`);
  const pushRes = supabaseCli(pushArgs, { env });
  if (pushRes.status !== 0) {
    throw new Error(`supabase db push → exit ${pushRes.status}: ${pushRes.stderr || pushRes.stdout}`);
  }
  log('done.');
}

function defaultSupabaseCli(args, opts = {}) {
  const r = spawnSync('supabase', args, { encoding: 'utf8', stdio: 'inherit', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
