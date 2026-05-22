# Plannen Integrations

> Postgres is Plannen's system of record. Every other place your data shows up
> is an **integration**: a read-only view, a write-mirror, or an export.

The storage tier (see [TIERED_DEPLOYMENT_MODEL.md](./TIERED_DEPLOYMENT_MODEL.md)) decides where Postgres + photos live. The integrations below sit on top of whichever tier you chose.

| Surface | Role | Direction | Configured via |
|---|---|---|---|
| Google Calendar | write-mirror | Plannen → GCal | `/plannen-setup` → Google OAuth |
| Google Photos | read-source | GPhotos → Plannen (picker) | `/plannen-setup` → Google OAuth |
| Google Drive | storage-mirror for memory uploads | Plannen ↔ Drive | `/plannen-setup` → Google OAuth |
| WhatsApp / email | notification sink | Plannen → user | edge function settings (Tier 1) |

Integrations are orthogonal to tier choice — pick any tier and any subset of integrations. New integration proposals get their own design spec in `docs/superpowers/specs/`.

## MCP server credentials

The MCP edge function accepts two credentials: `plnnn_` personal access
tokens (Claude Code plugin, CLI — pinned in `plugin.json`) and Supabase Auth
JWTs obtained via the OAuth 2.1 server (claude.ai custom connectors). Both
resolve to the same per-user RLS context, so a claude.ai session and a
Claude Code session see identical data. Enable the OAuth path on a Tier 2
project with `npx plannen cloud oauth enable --profile <name>`.

## Google OAuth setup (Calendar / Photos / Drive)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Photos Library API** (and Calendar / Drive APIs as needed).
2. Generate OAuth 2.0 credentials of type **Web application**.
3. Register the OAuth callback as an authorised redirect URI:
   - `local_pg`: `http://127.0.0.1:54323/functions/v1/google-oauth-callback`
   - `local_sb`: `http://127.0.0.1:54321/functions/v1/google-oauth-callback`
   - `cloud_sb`: `https://<your-ref>.supabase.co/functions/v1/google-oauth-callback`
4. Run `/plannen-setup` in Claude Code and paste the Client ID and Client Secret.

## Storage URL shape

Plannen pins `media_url` columns to Supabase Storage's URL shape: `/storage/v1/object/public/event-photos/<userId>/<filename>`. In Tier 0, the backend serves this URL pattern from `~/.plannen/photos/event-photos/` (override via `PLANNEN_PHOTOS_ROOT`). In Tier 1, real Supabase Storage serves it.

This pin means `media_url` rows are portable across tiers without rewriting. If Supabase ever changes the URL format, the Tier 0 mirror will need to follow suit (or the column has to be rewritten on tier switch).

## Why "integration" not "tier"

The earlier mental model treated Google Drive / Calendar as tiers ("Tier 2 = sync to cloud"). That conflated two independent axes:

- **Tier**: where Postgres + photos persist (your laptop, a hosted DB, a hosted Plannen instance).
- **Integration**: which external services Plannen also mirrors data to.

Confusing them led to questions like "if I want my photos backed up to Drive, do I have to use Supabase?" — the answer is **no**, those are separate decisions. The current model keeps them independent.

## S3-compatible storage

Photos can live in any S3-compatible bucket (Cloudflare R2, Tigris, Backblaze B2, MinIO, …) via the `PLANNEN_STORAGE_BACKEND=s3` setting. R2 in particular has zero egress, which is a big cost saver for a photo-heavy app.

### Backend values

| Value | Tier | Notes |
|---|---|---|
| `local-fs` | Tier 0 (locked) | Writes under `~/.plannen/photos` |
| `supabase` | Tier 1/2 default | Uses Supabase Storage's `event-photos` bucket |
| `s3` | Tier 1/2 opt-in | Any S3-compatible bucket |

Tier 0 is locked to `local-fs` — creating a Tier 0 profile with `--storage=s3` is refused.

### Enabling s3 on a new profile

```bash
npx plannen profile create r2-prod --mode=cloud_sb --storage=s3
npx plannen cloud provision --profile r2-prod
# answer "S3-compatible" when prompted, then supply the six S3_* keys
```

### Migrating an existing supabase deployment

```bash
# 1. copy bytes to the new bucket
npx plannen storage migrate --from supabase --to s3 --profile <name>

# 2. flip the env var (manual)
#    edit ~/.plannen/profiles/<name>/env, set PLANNEN_STORAGE_BACKEND=s3
npx plannen deploy --profile <name>

# 3. verify post-cutover
npx plannen storage migrate --from supabase --to s3 --profile <name> --verify-only
```

The old Supabase bucket is **not** deleted by the migrate command — keep it for at least one rollback window.
