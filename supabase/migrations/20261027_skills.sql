-- Skills mirror. Changelog note only: supabase/schema.sql is the canonical,
-- idempotent schema and already contains this. Do not run this file as a
-- second migration path. See supabase/migrations/README.md.
--
-- Added 2026-10-27 for mrhinkle/agent-kontrol#84.
-- skill_runs stores the start, the end, and an optional note (500 characters).
-- It does not store prompts or tool input or output.
-- The partial unique index on skill_sync_runs allows one status='running' row.
-- That is the sync lease. Overlapping syncs do not take it.

create table if not exists skill_sources (
  id text primary key,
  repo text not null,
  ref text,
  path_globs jsonb not null,
  label text not null,
  enabled boolean not null default true,
  position integer not null
);

insert into skill_sources (id, repo, ref, path_globs, label, enabled, position)
values
  ('master-skills', 'mrhinkle/master-skills', null, '["skills/*"]'::jsonb, 'master-skills', true, 0),
  ('the-gibson', 'The-AIE/the-gibson', null, '["skills/*", ".agents/skills/*"]'::jsonb, 'the-gibson', true, 1)
on conflict (id) do nothing;

create table if not exists skills (
  id text primary key,
  source_id text not null references skill_sources (id),
  path text not null,
  name text not null,
  description text not null default '',
  version text,
  sha text not null,
  commit_sha text,
  body text not null,
  "references" jsonb not null default '[]'::jsonb,
  runtimes jsonb not null,
  frontmatter jsonb not null default '{}'::jsonb,
  removed_at timestamptz,
  synced_at timestamptz not null default now()
);

create table if not exists skill_settings (
  skill_id text primary key references skills (id),
  trigger text not null default 'off' check (trigger in ('off', 'on_request', 'auto_inject', 'scheduled')),
  scope jsonb not null default '{"mode":"all","lanes":[]}'::jsonb,
  schedule text,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists skill_runs (
  run_id uuid primary key,
  skill_id text not null,
  skill_sha text not null,
  agent_id text not null,
  lane text,
  runtime text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  note text check (note is null or char_length(note) <= 500),
  actor_type text,
  actor_id text
);
create index if not exists skill_runs_skill_started_idx on skill_runs (skill_id, started_at desc);
create index if not exists skill_runs_started_idx on skill_runs (started_at desc);

create table if not exists skill_sync_runs (
  id uuid primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null check (trigger in ('manual', 'scheduled')),
  status text not null,
  summary jsonb,
  error text
);
create unique index if not exists skill_sync_one_running_idx
  on skill_sync_runs (status)
  where status = 'running';

create table if not exists skill_drift (
  host text not null,
  dir text not null,
  reported_at timestamptz not null default now(),
  entries jsonb not null,
  primary key (host, dir)
);
