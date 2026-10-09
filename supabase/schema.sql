-- Agent Kontrol schema (targets Neon / plain Postgres).
-- Apply with: psql "$DATABASE_URL" -f supabase/schema.sql
-- (Path kept under supabase/ for historical reasons; no Supabase-specific features.)

create table if not exists agents (
  id text primary key,                    -- slug, e.g. "cowork-mac-studio"
  platform text not null default 'other', -- claude-code | cowork-cloud | cowork-local | chatgpt-work | codex | hermes | other
  machine text,                           -- hostname, or "cloud"
  display_name text,
  last_seen_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists sessions (
  id text primary key,                    -- the platform's session id
  agent_id text references agents(id) on delete cascade,
  project text,                           -- repo/folder/initiative
  status text not null default 'active',  -- active | waiting | done | failed
  summary text,                           -- latest one-line "what I'm doing"
  started_at timestamptz default now(),
  ended_at timestamptz,
  updated_at timestamptz default now()
);
create index if not exists sessions_agent_idx on sessions (agent_id, updated_at desc);
create index if not exists sessions_updated_idx on sessions (updated_at desc);

create table if not exists events (
  id bigint generated always as identity primary key,
  agent_id text references agents(id) on delete cascade,
  session_id text,
  kind text not null,                     -- session_start | turn_start | waiting | notification | session_end | milestone | status | error | heartbeat
  title text,
  detail jsonb,
  created_at timestamptz default now()
);
create index if not exists events_created_idx on events (created_at desc);
create index if not exists events_agent_idx on events (agent_id, created_at desc);

create table if not exists memory (
  id bigint generated always as identity primary key,
  key text unique,                        -- optional stable key; UNIQUE constraint (NULLs distinct) so upsert ON CONFLICT (key) works
  content text not null,
  tags text[] not null default '{}',
  agent_id text,                          -- who wrote it
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists memory_tags_idx on memory using gin (tags);

-- Two-way messaging: operator ↔ agent conversations.
-- direction: inbound (operator→agent) | outbound (agent→operator). Ack keeps history.
create table if not exists messages (
  id bigint generated always as identity primary key,
  agent_id text not null,                 -- conversation peer (the agent)
  body text not null,
  created_by text default 'dashboard',
  created_at timestamptz default now(),
  delivered_at timestamptz,               -- when the agent fetched an inbound message
  acked_at timestamptz,                   -- when the agent consumed it (history kept)
  direction text not null default 'inbound', -- inbound | outbound
  in_reply_to bigint,                     -- optional parent message id
  thread_id text,                         -- root id as text; shared across a conversation
  read_by_dashboard_at timestamptz        -- when the operator opened/read an outbound reply
);
-- Additive upgrade path for existing deployments (also in migrations/).
alter table messages add column if not exists direction text not null default 'inbound';
alter table messages add column if not exists in_reply_to bigint;
alter table messages add column if not exists thread_id text;
alter table messages add column if not exists read_by_dashboard_at timestamptz;
update messages set thread_id = id::text where thread_id is null;

create index if not exists messages_pending_idx on messages (agent_id, acked_at, created_at);
create index if not exists messages_pending_inbound_idx
  on messages (agent_id, acked_at, created_at)
  where direction = 'inbound';
create index if not exists messages_unread_dashboard_idx
  on messages (agent_id, created_at)
  where direction = 'outbound' and read_by_dashboard_at is null;
create index if not exists messages_thread_idx
  on messages (agent_id, thread_id, created_at);


-- v2: the task queue. Agent Kontrol stops being a read-only dashboard and
-- becomes the harness: you (or an agent) queue work, the dispatcher daemon on
-- each machine claims tasks for its installed CLIs (claude / codex / grok),
-- runs them headless, and reports results + cost back.
create table if not exists tasks (
  id bigint generated always as identity primary key,
  title text not null,
  description text,                       -- full prompt/instructions for the agent
  project text,                           -- repo/folder under the dispatcher's workdir
  platform text not null default 'any',   -- claude-code | codex | grok | hermes | cowork-cloud | any
  machine text,                           -- optional: pin to one machine's dispatcher
  priority int not null default 2,        -- 1 high, 2 normal, 3 low
  status text not null default 'queued',  -- queued | claimed | running | review | done | failed | cancelled
  reviewer_platform text,                 -- optional cross-vendor review, e.g. claude writes -> codex reviews
  assigned_agent text,                    -- agent id that claimed it
  session_id text,                        -- platform session id of the run, if known
  result text,                            -- final summary (and review verdict)
  cost_usd numeric,                       -- from claude -p json / dispatcher estimate
  created_by text default 'dashboard',
  created_at timestamptz default now(),
  claimed_at timestamptz,
  updated_at timestamptz default now(),
  completed_at timestamptz
);
create index if not exists tasks_queue_idx on tasks (status, platform, priority, created_at);
create index if not exists tasks_updated_idx on tasks (updated_at desc);

-- OAuth 2.1 authorization server (self-hosted, for MCP clients).
-- Access tokens are stateless signed JWTs; only clients + auth codes are stored.
create table if not exists oauth_clients (
  client_id text primary key,
  client_secret text,                     -- null for public/PKCE clients
  redirect_uris jsonb not null,
  client_name text,
  token_endpoint_auth_method text default 'none',
  grant_types jsonb,
  created_at timestamptz default now()
);

create table if not exists oauth_codes (
  code text primary key,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scope text,
  resource text,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists oauth_codes_expires_idx on oauth_codes (expires_at);

-- v3: the progress board. One append-only row per repo per collection tick.
-- Written by scripts/collect-progress.sh via POST /api/progress/ingest; read by
-- /progress. History is the whole point: "how deep was the backlog on Aug 12"
-- is not answerable from the GitHub API after the fact, so we snapshot.
create table if not exists repo_snapshots (
  id bigint generated always as identity primary key,
  repo text not null,                     -- "example-org/app-server"
  label text,                             -- display name, e.g. "App Server"
  collected_at timestamptz not null,      -- logical tick time (UTC)
  kind text not null default 'tick',      -- tick | daily | backfill

  -- point-in-time queue depth
  open_issues int,
  open_prs int,
  blocked_issues int,                     -- open issues labelled dependency-blocked

  -- rolling 24h window counts, as of collected_at
  merged_prs_24h int,
  issues_closed_24h int,
  issues_opened_24h int,

  -- cumulative totals — the two lines on the graph. Monotonic, so the gap
  -- between them is the backlog at that moment, and differencing two rows
  -- gives an exact window count without summing overlapping ticks.
  total_issues_created int,
  total_issues_closed int,
  total_prs_merged int,

  -- optional review economics (null when review-metrics.sh isn't available)
  review_rounds numeric,
  no_verdict_rate numeric,

  detail jsonb,                           -- lane_mix, stalled_prs, collector notes
  created_at timestamptz default now()
);
-- One row per repo per tick. Re-running the collector for the same instant
-- (or backfilling a day twice) updates in place instead of double-counting.
create unique index if not exists repo_snapshots_unique_tick
  on repo_snapshots (repo, collected_at);
create index if not exists repo_snapshots_repo_time_idx
  on repo_snapshots (repo, collected_at desc);
create index if not exists repo_snapshots_time_idx
  on repo_snapshots (collected_at desc);

-- ============================================================
-- Usage and Costs (Phase 1) — usage ledger for Hermes + providers
-- Apply with: psql "$DATABASE_URL" -f supabase/schema.sql
-- Idempotent: create-if-not-exists + price seed upsert.
-- ============================================================

create table if not exists model_prices (
  version text not null,
  model text not null,
  input_per_mtok numeric not null,
  output_per_mtok numeric not null,
  cache_read_per_mtok numeric not null default 0,
  cache_write_per_mtok numeric,
  currency text not null default 'usd',
  notes text,
  effective_from date,
  primary key (version, model)
);

create table if not exists usage_accounts (
  id text primary key,
  provider text not null,
  label text not null,
  billing_type text not null,          -- api | subscription | credits | agent_logged
  monthly_fee_usd numeric,
  secret_env text,                     -- env var NAME only, never the value
  active boolean not null default true,
  detail jsonb,
  updated_at timestamptz default now()
);

create table if not exists usage_facts (
  id bigint generated always as identity primary key,
  -- Application-computed idempotency key (source|account|profile|session|model|provider|mode|task)
  idempotency_key text not null,
  source text not null default 'hermes_state',  -- hermes_state | provider_api | subscription_fee | quota_snapshot
  account_id text not null,
  profile text,                        -- hermes profile slug (host/alpha, neuro/gateway, …)
  session_id text,
  model text not null,
  billing_provider text,
  billing_mode text,
  cron_job_id text,                    -- parsed from session_id when present
  cron_job_name text,                  -- resolved from profile cron/jobs.json (never the prompt)
  task text,                           -- hermes task label (title_generation, …) — never prompt content
  api_call_count int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  paid_cost_usd numeric not null default 0,
  shadow_cost_usd numeric not null default 0,
  price_version text,
  cost_status text,
  first_seen_at timestamptz,
  last_seen_at timestamptz not null,
  collected_at timestamptz not null default now(),
  detail jsonb,
  unique (idempotency_key)
);
create index if not exists usage_facts_time_idx on usage_facts (last_seen_at desc);
create index if not exists usage_facts_profile_idx on usage_facts (profile, last_seen_at desc);
create index if not exists usage_facts_account_idx on usage_facts (account_id, last_seen_at desc);
create index if not exists usage_facts_source_idx on usage_facts (source, last_seen_at desc);
create index if not exists usage_facts_cron_idx on usage_facts (cron_job_id, last_seen_at desc);
create index if not exists usage_facts_model_idx on usage_facts (model, last_seen_at desc);

create table if not exists account_snapshots (
  id bigint generated always as identity primary key,
  account_id text not null,
  collected_at timestamptz not null,
  balance_usd numeric,
  credits_remaining numeric,
  quota_detail jsonb,
  detail jsonb,
  unique (account_id, collected_at)
);

-- Seed price version 2026-10-05 (fallback switched to base deepseek-v4-pro)
insert into model_prices (version, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, notes, effective_from)
values
  ('2026-10-05', 'gpt-5.6-sol', 4.00, 20.00, 0.40, 'Codex list', '2026-10-05'),
  ('2026-10-05', 'gpt-5.6-luna', 0.20, 1.20, 0.02, 'Codex list', '2026-10-05'),
  ('2026-10-05', 'deepseek/deepseek-v4-pro', 0.2088, 0.4176, 0.0174, 'Current OpenRouter fallback', '2026-10-05'),
  ('2026-10-05', 'deepseek/deepseek-v4-pro-0813', 0.40, 5.00, 0.36, 'Historical only (pre-switch)', '2026-09-01')
on conflict (version, model) do update set
  input_per_mtok = excluded.input_per_mtok,
  output_per_mtok = excluded.output_per_mtok,
  cache_read_per_mtok = excluded.cache_read_per_mtok,
  notes = excluded.notes;

-- Settings: the repos the progress board watches. Edited from the Settings page;
-- with no rows the app falls back to progress.config.json. Uniqueness of the short
-- name is enforced by validation, not an index, so rows can be reordered freely.
create table if not exists watched_repos (
  repo text primary key,                  -- owner/name
  label text not null,
  short text not null,
  color text not null default '#2563eb',
  blocked_label text,                     -- null means blocked work is not tracked
  position integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
