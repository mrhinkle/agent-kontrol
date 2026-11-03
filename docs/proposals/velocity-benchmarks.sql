-- PROPOSAL ONLY — not applied. Explicit operator approval is required.
-- Additive storage for development-velocity captures. No existing rows change.
-- Application exposes INSERT/SELECT only. Database administrators retain SQL access.
create table if not exists velocity_benchmarks (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  metric_version text not null,
  scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  window_end timestamptz not null,
  captured_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  actor_type text not null,
  actor_id text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  check (window_start < window_end)
);
create index if not exists velocity_benchmarks_trend_idx
  on velocity_benchmarks (scope_key, metric_version, window_end desc, captured_at desc);
alter table velocity_benchmarks enable row level security;
-- No anonymous/public data policies. Access uses the existing authenticated server.
