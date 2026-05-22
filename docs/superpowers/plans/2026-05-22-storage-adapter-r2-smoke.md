# Storage Adapter (R2/S3) — manual smoke checklist

**Status:** Pending — programmatic checks (Tier-0 s3 refusal, CLI shape, test suites) all passed on commit `dbcfee80afc3ab06ae883f9114a313e99f751843`. The four scenarios below require a running stack and cannot be automated.

## Programmatic checks (done)

- [x] Tier-0 s3 refusal: `plannen profile create bad --mode=local_pg --storage=s3` exits non-zero with the expected error.
- [x] `plannen storage migrate --help` works, lists `--from`/`--to`/`--profile`/`--verify-only`.
- [x] Backend tests: 60 passing (23 test files skipped — require live DATABASE_URL).
- [x] Frontend tests: 579 passing, 1 skipped (54 test files — all passing).
- [x] CLI tests: included in frontend run above (54 test files, 579 passing).

> **Note:** Fixed a test gap during this run — `cloud-provision.test.mjs` had a stale STEPS count of 11; updated to 12 to include the new `configure-storage` step added by this feature.

## Manual checks (remaining)

### 1. Tier 0 — local-fs end-to-end

```bash
npx plannen profile create smoke-t0 --mode=local_pg
npx plannen up --profile smoke-t0
# In the web UI: upload a photo to a new event.
ls ~/.plannen/photos/event-photos/<userId>/<eventId>/
```
**Expected:** one file with a UUID name, ext matching the upload.

### 2. Tier 1 — supabase backend, no behaviour change

```bash
npx plannen profile create smoke-t1 --mode=local_sb
npx plannen up --profile smoke-t1
# Upload a photo via the web UI.
psql "$DATABASE_URL" -c "SELECT storage_key FROM plannen.event_memories ORDER BY created_at DESC LIMIT 1;"
```
**Expected:** key is `<userId>/<eventId>/<uuid>.<ext>`. File visible in Supabase Studio's event-photos bucket.

### 3. Tier 2 — fresh provision with s3 backend

```bash
npx plannen profile create smoke-t2-r2 --mode=cloud_sb --storage=s3
npx plannen cloud provision --profile smoke-t2-r2
# (supply R2 creds when prompted; expect "S3 credentials verified")
npx plannen deploy --profile smoke-t2-r2
# Open the deployed URL, upload a photo.
```
**Expected:** R2 bucket now has `<userId>/<eventId>/<uuid>.<ext>`. UI displays the image.

### 4. Migration — Tier 1 supabase → s3

```bash
# On an existing supabase-backed profile that already has memories:
npx plannen storage migrate --from supabase --to s3 --profile <prof>
# Edit ~/.plannen/profiles/<prof>/env: PLANNEN_STORAGE_BACKEND=s3
npx plannen deploy --profile <prof>
npx plannen storage migrate --from supabase --to s3 --profile <prof> --verify-only
```
**Expected:** `verify: N/N present and size-match`, exit 0.
