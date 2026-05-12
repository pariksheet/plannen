---
description: Back up the local Plannen DB and event-photos bucket via scripts/export-seed.sh.
argument-hint: ""
---

The user has invoked `/plannen-backup`. Run the project's export-seed script.

```bash
bash scripts/export-seed.sh
```

The script writes two artefacts to `supabase/`:

- `seed.sql` — DB rows, auto-loaded on `supabase db reset`.
- `seed-photos.tar.gz` — tarball of the `event-photos` storage bucket. **Photos are not restored automatically** — extract manually after a reset.

Both files are gitignored. Report back the file sizes and a one-line confirmation.

Always run this **before** any DB migration or destructive operation. **Never run `supabase db reset`** unless the user has explicitly accepted that all local data will be wiped — and even then, take a backup first.
