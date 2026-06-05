// Vercel serverless function — /api/health
//
// Used by the release-staging.yml smoke check after a deploy completes
// (a single curl, not a full suite). Returns 200 + minimal build info so
// the check is one HTTP round-trip and human-greppable.
//
// Vercel auto-detects this file because vercel.json sets framework=vite +
// the rewrites rule excludes /api/ paths from SPA fallback.

export default function handler() {
  return Response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    env: process.env.VERCEL_ENV ?? 'unknown',
  });
}
