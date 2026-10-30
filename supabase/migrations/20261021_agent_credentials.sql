-- Per-agent credentials (issue #40). Idempotent. Safe to re-run.
-- This file is a changelog. The same statements are in schema.sql, which is
-- what you apply. You do not need to run this file separately.
--
-- Stored: label, 8-character token prefix, SHA-256 hex of the token, scopes,
-- created_at, expires_at, revoked_at, last_used_at.
-- Not stored: the token itself, prompts, or tool input/output.

create table if not exists agent_credentials (
  id text primary key,
  label text not null,
  token_prefix text not null,
  token_hash text not null,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);
alter table agent_credentials add column if not exists label text;
alter table agent_credentials add column if not exists token_prefix text;
alter table agent_credentials add column if not exists token_hash text;
alter table agent_credentials add column if not exists scopes text[];
alter table agent_credentials add column if not exists created_at timestamptz not null default now();
alter table agent_credentials add column if not exists expires_at timestamptz;
alter table agent_credentials add column if not exists revoked_at timestamptz;
alter table agent_credentials add column if not exists last_used_at timestamptz;
create unique index if not exists agent_credentials_token_hash_idx on agent_credentials (token_hash);
