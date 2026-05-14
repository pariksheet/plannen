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

## Storage URL shape

Plannen pins `media_url` columns to Supabase Storage's URL shape: `/storage/v1/object/public/event-photos/<userId>/<filename>`. In Tier 0, the backend serves this URL pattern from `~/.plannen/photos/event-photos/` (override via `PLANNEN_PHOTOS_ROOT`). In Tier 1, real Supabase Storage serves it.

This pin means `media_url` rows are portable across tiers without rewriting. If Supabase ever changes the URL format, the Tier 0 mirror will need to follow suit (or the column has to be rewritten on tier switch).

## Why "integration" not "tier"

The earlier mental model treated Google Drive / Calendar as tiers ("Tier 2 = sync to cloud"). That conflated two independent axes:

- **Tier**: where Postgres + photos persist (your laptop, a hosted DB, a hosted Plannen instance).
- **Integration**: which external services Plannen also mirrors data to.

Confusing them led to questions like "if I want my photos backed up to Drive, do I have to use Supabase?" — the answer is **no**, those are separate decisions. The current model keeps them independent.
