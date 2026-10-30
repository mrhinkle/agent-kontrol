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
  created_by text default 'dashboard',    -- free-text label from the caller; not the authenticated actor
  actor_type text,                        -- human | agent; null on rows written before this column
  actor_id text,                          -- credential id, mc-token, oauth client id, or operator
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
alter table messages add column if not exists actor_type text;
alter table messages add column if not exists actor_id text;
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
  created_by text default 'dashboard',    -- free-text label from the caller; not the authenticated actor
  actor_type text,                        -- human | agent; null on rows written before this column
  actor_id text,                          -- credential id, mc-token, oauth client id, or operator
  created_at timestamptz default now(),
  claimed_at timestamptz,
  updated_at timestamptz default now(),
  completed_at timestamptz
);
alter table tasks add column if not exists actor_type text;
alter table tasks add column if not exists actor_id text;
create index if not exists tasks_queue_idx on tasks (status, platform, priority, created_at);
create index if not exists tasks_updated_idx on tasks (updated_at desc);

-- One open scheduler task per skill. The skill tick checks for an open task and
-- then inserts; this index is what makes that atomic when two ticks race.
create unique index if not exists tasks_skill_schedule_one_open_idx
  on tasks (title)
  where actor_id = 'skill-scheduler'
    and title like 'Run scheduled skill %'
    and status in ('queued', 'claimed', 'running', 'review');

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

  detail jsonb,                           -- lane_mix, stalled_prs, notes; brief keys stuck_prs, median_lead_hours, stale_issues, drafts, merged are optional
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

-- Settings: the repos the progress board watches. Edited from the Settings page.
-- With no rows and no watched owners, the app falls back to progress.config.json.
-- Short names are unique. The constraint is deferrable so one statement can swap
-- two shorts without a false conflict. Discovery also serializes allocation.
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

-- Owner discovery (#66). watched_owners names the GitHub logins to list.
-- watched_repos stays the override layer: origin manual|auto, pin, hide.
-- Hide wins over pin. gone means the repo left the last successful gh list
-- and is not shown, including when pinned. A failed or empty gh list must
-- not delete or hide rows; it records last_error on the owner instead.
create table if not exists watched_owners (
  owner text primary key,
  activity_days integer not null default 30,
  include_forks boolean not null default false,
  include_archived boolean not null default false,
  last_error text,
  last_error_at timestamptz,
  last_discovered_at timestamptz,
  actor_type text,                        -- human | agent; null for dev-open
  actor_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table watched_repos add column if not exists origin text not null default 'manual';
alter table watched_repos add column if not exists pinned boolean not null default false;
alter table watched_repos add column if not exists hidden boolean not null default false;
alter table watched_repos add column if not exists gone boolean not null default false;
alter table watched_repos add column if not exists is_fork boolean not null default false;
alter table watched_repos add column if not exists is_archived boolean not null default false;
alter table watched_repos add column if not exists last_activity_at timestamptz;
-- null: discovery owns label, short, color, and blocked_label.
-- true: a hand-added save overrode those fields. false: a later save cleared them.
-- No default, so an existing row stays null until a hand-added save touches it.
alter table watched_repos add column if not exists fields_overridden boolean;

-- Deferrable so replaceWatchedRepos can swap two short names in one statement.
-- Checked at the end of that statement (initially immediate). Discovery retries
-- a 23505 once, then the route answers 409.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'watched_repos_short_key'
      and conrelid = 'watched_repos'::regclass
  ) and exists (
    select 1 from watched_repos group by short having count(*) > 1
  ) then
    -- Never fail the build on legacy data: every deploy applies this file. Skip the
    -- constraint and say why; discovery's advisory lock still serializes allocation.
    raise warning 'watched_repos has duplicate short names; watched_repos_short_key not added. Rename the duplicates, then redeploy.';
  elsif not exists (
    select 1
    from pg_constraint
    where conname = 'watched_repos_short_key'
      and conrelid = 'watched_repos'::regclass
  ) then
    alter table watched_repos
      add constraint watched_repos_short_key
      unique (short)
      deferrable initially immediate;
  end if;
end $$;

-- Traces: OpenTelemetry-style spans from agents. A trace is the tree of spans that
-- share a trace_id (a session, its turns, the tool and model calls inside them).
-- Spans are upserted by (trace_id, span_id) so an open span can be closed later.
-- Old rows are pruned after MC_TRACE_RETENTION_DAYS (default 30).
create table if not exists spans (
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  agent_id text not null,
  session_id text,
  name text not null,
  kind text not null default 'other',     -- session | turn | tool | model | other
  status text not null default 'unset',   -- ok | error | unset
  status_message text,
  started_at timestamptz not null,
  ended_at timestamptz,                   -- null while the span is open
  attributes jsonb not null default '{}'::jsonb,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric,
  created_at timestamptz default now(),
  primary key (trace_id, span_id)
);
create index if not exists spans_started_idx on spans (started_at desc);
create index if not exists spans_agent_idx on spans (agent_id, started_at desc);
create index if not exists spans_session_idx on spans (session_id);

-- Automatic session notes: `source` marks rows the server wrote itself so cleanup never
-- touches notes an agent wrote; `facts_at` is the newest event the note was built from, so
-- a slower, staler write can never replace a newer note.
alter table memory add column if not exists source text;
alter table memory add column if not exists facts_at timestamptz;
create index if not exists memory_auto_idx on memory (updated_at) where source = 'automatic-session';
create index if not exists events_session_idx on events (session_id, created_at);
create index if not exists spans_session_kind_idx on spans (session_id, kind);

-- Per-agent credentials. The token is shown once at creation and is not stored.
-- token_prefix is the first 8 characters, for the settings list.
-- token_hash is the SHA-256 hex of the full token.
-- scopes is the allow-list enforced on MCP tools and agent REST routes.
-- Timestamps record creation, optional expiry, revocation, and last successful use.
-- Prompts and tool input/output are not stored in this table.
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
-- Per-credential request quotas (issue #51). One unit is one authorized
-- HTTP request made with the credential. The minute window is the clock
-- minute, the day window is the UTC day; both are fixed windows. Existing
-- rows get the defaults (60 per minute, 10000 per day). Limits are 1 to
-- 1000000; there is no unlimited value. The *_start and *_count columns hold
-- only the current window start and how many requests it has counted.
alter table agent_credentials add column if not exists rate_limit_per_minute integer not null default 60
  constraint agent_credentials_rate_limit_per_minute_range check (rate_limit_per_minute between 1 and 1000000);
alter table agent_credentials add column if not exists rate_limit_per_day integer not null default 10000
  constraint agent_credentials_rate_limit_per_day_range check (rate_limit_per_day between 1 and 1000000);
alter table agent_credentials add column if not exists rate_minute_start timestamptz;
alter table agent_credentials add column if not exists rate_minute_count integer not null default 0
  constraint agent_credentials_rate_minute_count_nonneg check (rate_minute_count >= 0);
alter table agent_credentials add column if not exists rate_day_start timestamptz;
alter table agent_credentials add column if not exists rate_day_count integer not null default 0
  constraint agent_credentials_rate_day_count_nonneg check (rate_day_count >= 0);

-- Decisions queue (see supabase/migrations/20261025_decisions.sql and docs/VELOCITY.md).
-- kind, labels, opened_at, repo_short and github_present are nullable additions
-- so a database that already created the table still upgrades. The brief's
-- decisions list is computed from these columns; it does not call GitHub again.
create table if not exists decisions (
  id bigint generated always as identity primary key,
  key text not null unique,
  source text not null,
  repo text,
  number int,
  url text,
  title text not null,
  why text,
  options jsonb,
  recommended text,
  requested_by text,
  status text not null default 'open',
  decision text,
  decided_by text,
  decided_at timestamptz,
  defer_until timestamptz,
  kind text,
  labels jsonb,
  opened_at timestamptz,
  repo_short text,
  github_present boolean,
  actor_type text,
  actor_id text,
  chosen_option text,
  writeback text,
  writeback_lock text,
  writeback_lock_at timestamptz,
  revision integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table decisions add column if not exists kind text;
alter table decisions add column if not exists labels jsonb;
alter table decisions add column if not exists opened_at timestamptz;
alter table decisions add column if not exists repo_short text;
alter table decisions add column if not exists github_present boolean;
alter table decisions add column if not exists actor_type text;
alter table decisions add column if not exists actor_id text;
alter table decisions add column if not exists chosen_option text;
alter table decisions add column if not exists writeback text;
alter table decisions add column if not exists writeback_lock text;
alter table decisions add column if not exists writeback_lock_at timestamptz;
alter table decisions add column if not exists revision integer not null default 0;
create index if not exists decisions_status_first_seen_idx on decisions (status, first_seen_at);
create index if not exists decisions_repo_number_idx on decisions (repo, number);

-- Threshold-alert dedupe (see supabase/migrations/20261028_brief_alerts.sql).
-- One row per alert key. Coordinator silence re-claims while last_sent_at is
-- older than the repeat interval, and only when cleared_at is null or older
-- than the claim's compute instant. A zero-merge row re-arms only after
-- cleared_at is set, and only when that clear is older than the claim.
-- A decision row is inserted once, and only while the decision is still open
-- and old enough. A clear cannot overwrite a newer last_sent_at.
-- cleared_at is nullable: null means the alert is still latched.
-- claim_token is the attempt that owns a claim. A failed message insert
-- restores the previous row only while this token still matches and
-- cleared_at is still the null the claim wrote.
create table if not exists brief_alerts (
  key text primary key,
  first_sent_at timestamptz not null,
  last_sent_at timestamptz not null,
  cleared_at timestamptz,
  claim_token text
);
alter table brief_alerts add column if not exists cleared_at timestamptz;
alter table brief_alerts add column if not exists claim_token text;

-- Client idempotency keys for create_task, operator messages, and replies.
-- scope is actor_type:actor_id:route, so two callers can reuse one key string.
-- response is null until the write stores a result. The resource insert
-- and that response commit in one statement, and the insert runs only
-- while claim_token still matches. started_at begins a 30 second lease on
-- an empty claim. claim_token is the attempt that owns the lease, including
-- when the claim insert commits and the connection drops before RETURNING
-- arrives. A key is unused after expires_at (24 hours from the claim).
-- Changelog: supabase/migrations/20261025_idempotency.sql
-- and supabase/migrations/20261026_idempotency_lease.sql.
create table if not exists idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  response jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  claim_token text,
  primary key (scope, idempotency_key)
);
alter table idempotency_keys add column if not exists started_at timestamptz;
alter table idempotency_keys add column if not exists claim_token text;

-- Skills mirror (see supabase/migrations/20261027_skills.sql and docs/MCP.md).
-- Agent Kontrol copies SKILL.md files from the seeded git sources. It does not
-- execute them. skill_runs stores a start and an end, plus an optional note of
-- at most 500 characters. It does not store prompts or tool input or output.
-- A second sync cannot insert another status='running' row: the partial unique
-- index is the lease. A row left running is expired by the next sync after
-- 10 minutes, which is what keeps a crashed sync from wedging the mirror.
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
  category text,
  tags jsonb not null default '[]'::jsonb,
  removed_at timestamptz,
  synced_at timestamptz not null default now()
);
alter table skills add column if not exists category text;
alter table skills add column if not exists tags jsonb not null default '[]'::jsonb;

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

-- Host liveness beats (see supabase/migrations/20261027_watch_beats.sql).
-- One row per source. received_at is the database clock at the last successful
-- write; beat_at is the sender's instant and does not decide acceptance,
-- overwrite order, or liveness age. detail is at most 500 Unicode code points
-- (char_length). The dated migration is a changelog; apply-schema runs this file.
create table if not exists watch_beats (
  source text primary key check (char_length(source) > 0),
  status text not null check (status in ('ok', 'held', 'paused', 'stale', 'failing', 'unknown')),
  detail text not null check (char_length(detail) <= 500),
  beat_at timestamptz not null,
  received_at timestamptz not null default now()
);

-- GitHub webhook inbox (#77, see supabase/migrations/20261030012111_gh_events.sql).
-- One row per delivery. delivery_id is X-GitHub-Delivery for a real delivery.
-- Ids that start with 'sweep:' are reserved for synthetic rows written by the
-- sweeper (#79). POST /api/webhooks/github rejects them. event has no enum so
-- synthetic names fit. id is the consumer cursor (#78). processed_at is set by
-- consumers. Deleting rows older than 30 days belongs to the sweeper (#79).
create table if not exists gh_events (
  id bigserial primary key,
  delivery_id text not null unique check (char_length(delivery_id) between 1 and 200),
  event text not null check (char_length(event) between 1 and 64),
  action text,
  repo text,
  number bigint,
  head_sha text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists gh_events_received_at_idx on gh_events (received_at);
create index if not exists gh_events_pending_idx on gh_events (id) where processed_at is null;

-- Absence sweeper (#79, see supabase/migrations/20261030013738_absence_sweeper.sql
-- and docs/VELOCITY.md). Additive: two nullable events columns and seven tables.

-- Who reported an event, from verified server authentication (never from the
-- request body). kind is legacy | agent | oauth | session. id is mc-token, the
-- credential id, the OAuth client id, or operator. Null on rows written before
-- this column and on dev-open writes: those rows are unmeasured for liveness.
alter table events add column if not exists principal_kind text;
alter table events add column if not exists principal_id text;
create index if not exists events_work_principal_idx
  on events (agent_id, created_at desc)
  where principal_kind is not null and kind in ('session_end', 'milestone', 'status');

-- Explicit consumer registrations. No row is created implicitly.
-- reporters lists the {kind, id} principals whose work events prove liveness.
-- queue maps the work the consumer serves. registered_at is set on insert only.
create table if not exists sweep_consumers (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  agent_ids text[] not null check (cardinality(agent_ids) between 1 and 20),
  reporters jsonb not null check (jsonb_typeof(reporters) = 'array'),
  queue jsonb not null check (jsonb_typeof(queue) = 'object'),
  scheduler_source text,
  scheduler_job text,
  enabled boolean not null default true,
  max_silence_hours numeric not null default 3 check (max_silence_hours > 0 and max_silence_hours <= 168),
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  actor_type text,
  actor_id text
);

-- Append-only audit of every accepted trusted observation and registration.
-- outcome says what the write did to the projection (applied, refreshed,
-- older, replay). principal_* is from authentication.
create table if not exists sweep_observations (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('scheduler_job', 'queue', 'pr_snapshot', 'consumer')),
  source text not null,
  subject text not null,
  seq bigint,
  outcome text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  principal_kind text not null,
  principal_id text not null,
  received_at timestamptz not null
);
create index if not exists sweep_observations_subject_idx on sweep_observations (kind, subject, id desc);

-- Current scheduler job state, one row per source and job. transition is the
-- source's monotonic transition id. A lower transition never replaces a higher
-- one. The same transition only refreshes and only adds or replaces non-null
-- fields. prior_* is the state this transition replaced. resumed is true when
-- this transition was observed going from paused to active; decision is then
-- that resume's own citation.
create table if not exists scheduler_jobs (
  source text not null,
  job_id text not null,
  state text not null check (state in ('active', 'paused')),
  transition bigint not null check (transition >= 1),
  paused_at timestamptz,
  paused_reason text,
  until timestamptz,
  decision text,
  prior_state text,
  prior_transition bigint,
  prior_decision text,
  resumed boolean not null default false,
  observed_at timestamptz,
  stale_after_minutes integer not null default 30 check (stale_after_minutes between 5 and 1440),
  transition_received_at timestamptz not null,
  last_received_at timestamptz not null,
  last_observation_id bigint,
  version bigint not null default 1,
  primary key (source, job_id)
);

-- Queue readiness from a collector, one row per queue. seq orders a source's
-- observations. complete false is unknown, never zero. empty_since is the
-- receipt time of the first observation in an unbroken run of complete,
-- fresh observations with raw work and nothing ready.
create table if not exists sweep_queues (
  queue text primary key,
  source text not null,
  classification text not null check (classification in ('issue_dispatch', 'pr_review')),
  repo text,
  complete boolean not null,
  error text,
  ready_count integer check (ready_count is null or ready_count >= 0),
  raw_count integer check (raw_count is null or raw_count >= 0),
  ready_refs jsonb,
  raw_refs jsonb,
  seq bigint not null,
  observed_at timestamptz,
  stale_after_minutes integer not null default 30 check (stale_after_minutes between 5 and 1440),
  received_at timestamptz not null,
  empty_since timestamptz,
  last_observation_id bigint,
  version bigint not null default 1
);

-- The newest PR snapshot per repository (lowercased owner/name).
create table if not exists sweep_pr_sources (
  repo_key text primary key,
  repo text not null,
  source text not null,
  complete boolean not null,
  error text,
  seq bigint not null,
  observed_at timestamptz,
  stale_after_minutes integer not null default 30 check (stale_after_minutes between 5 and 1440),
  received_at timestamptz not null,
  last_observation_id bigint,
  version bigint not null default 1
);

-- Current-head PR facts from complete snapshots. open false means a later
-- complete snapshot no longer listed it. green_since is the receipt time of
-- the first observation with required checks green at this head and check
-- state; a head or check-state change resets it.
create table if not exists sweep_prs (
  repo_key text not null,
  number integer not null check (number > 0),
  repo text not null,
  title text,
  url text,
  open boolean not null,
  draft boolean,
  opened_at timestamptz,
  mergeable text check (mergeable is null or mergeable in ('mergeable', 'conflicting', 'unknown')),
  head_sha text,
  checks_state text check (checks_state is null or checks_state in ('success', 'pending', 'failure', 'unknown')),
  checks_head_sha text,
  review_started boolean,
  review_head_sha text,
  green_since timestamptz,
  seq bigint not null,
  received_at timestamptz not null,
  version bigint not null default 1,
  primary key (repo_key, number)
);

-- One latch per condition and entity, kept independently of inbox retention.
-- episode counts firings from clear; seq counts emissions within an episode.
create table if not exists sweep_latches (
  condition text not null,
  entity_key text not null,
  active boolean not null default false,
  episode integer not null default 0,
  seq integer not null default 0,
  first_fired_at timestamptz,
  last_emitted_at timestamptz,
  cleared_at timestamptz,
  last_state text,
  last_evaluated_at timestamptz,
  evidence_version bigint,
  updated_at timestamptz not null default now(),
  primary key (condition, entity_key)
);
create index if not exists sweep_latches_active_idx on sweep_latches (condition) where active;
