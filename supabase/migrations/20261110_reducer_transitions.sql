-- Deterministic reducers (#80). Changelog only. The same statements are in schema.sql.
-- Additive: two new tables. No existing table or column changes.
-- reducer_transitions is the transition log. One row per transition_key.
-- A row is inserted started before any GitHub write. steps records completed
-- writes so a retry performs only the missing ones. attempts stops at 5.
-- reducer_locks is the per-PR lock (lowercased owner/name#number). expires_at
-- lets a crashed holder be replaced. Release deletes the row.

create table if not exists reducer_transitions (
  transition_key text primary key check (char_length(transition_key) between 1 and 500),
  reducer text not null check (char_length(reducer) between 1 and 80),
  repo text,
  number bigint,
  head_sha text,
  status text not null check (status in ('started', 'half_done', 'done', 'failed', 'skipped', 'dropped')),
  reason text,
  steps jsonb not null default '{}'::jsonb check (jsonb_typeof(steps) = 'object'),
  attempts int not null default 0 check (attempts >= 0 and attempts <= 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reducer_transitions_failed_idx
  on reducer_transitions (updated_at desc)
  where status = 'failed';

create table if not exists reducer_locks (
  lock_key text primary key check (char_length(lock_key) between 1 and 300),
  token text not null,
  expires_at timestamptz not null
);
