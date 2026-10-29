-- Changelog only. scripts/apply-schema.mjs applies supabase/schema.sql, not this file.
-- Host liveness beats (mrhinkle/agent-kontrol#81). One row per source.
-- received_at is the database clock at the last successful write.
-- beat_at is the sender's instant and does not decide acceptance,
-- overwrite order, or liveness age. detail is at most 500 Unicode code points.

create table if not exists watch_beats (
  source text primary key check (char_length(source) > 0),
  status text not null check (status in ('ok', 'held', 'paused', 'stale', 'failing', 'unknown')),
  detail text not null check (char_length(detail) <= 500),
  beat_at timestamptz not null,
  received_at timestamptz not null default now()
);
