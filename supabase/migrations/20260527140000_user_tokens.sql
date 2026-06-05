-- supabase/migrations/20260527140000_user_tokens.sql
--
-- Per-user MCP Personal Access Tokens. Replaces the shared MCP_BEARER_TOKEN.
-- Validation in supabase/functions/mcp/server.ts hashes the supplied bearer
-- and looks it up here; rows return user_id which the function sets as
-- app.current_user_id so RLS policies on every other table scope naturally.
--
-- Renamed from 20260519180000_user_tokens.sql on 2026-05-27 so the timestamp
-- sorts after the mailbox-sync-rework migration already on sb_prod. The
-- DROP POLICY IF EXISTS preambles below make this migration safe to re-apply
-- on local Tier 0 / Tier 1 envs that may already have run the earlier-named
-- version.

create table if not exists plannen.user_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references plannen.users(id) on delete cascade,
  label         text not null check (length(trim(label)) > 0),
  token_hash    bytea not null,
  prefix        text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz
);

create unique index if not exists user_tokens_token_hash_idx
  on plannen.user_tokens (token_hash);

create index if not exists user_tokens_user_id_idx
  on plannen.user_tokens (user_id);

alter table plannen.user_tokens enable row level security;

drop policy if exists user_tokens_select_self on plannen.user_tokens;
create policy user_tokens_select_self on plannen.user_tokens
  for select using (user_id = auth.uid());

drop policy if exists user_tokens_insert_self on plannen.user_tokens;
create policy user_tokens_insert_self on plannen.user_tokens
  for insert with check (user_id = auth.uid());

drop policy if exists user_tokens_delete_self on plannen.user_tokens;
create policy user_tokens_delete_self on plannen.user_tokens
  for delete using (user_id = auth.uid());
-- No UPDATE policy: tokens are immutable once minted.
